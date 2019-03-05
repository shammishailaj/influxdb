package http

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/influxdata/flux"
	"github.com/julienschmidt/httprouter"
	"github.com/opentracing/opentracing-go"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"

	"github.com/influxdata/influxdb/kit/tracing"
	"github.com/influxdata/influxdb/query"
)

const (
	proxyQueryPath = "/api/v2/queryproxysvc"
)

type ProxyQueryHandler struct {
	*httprouter.Router

	Logger *zap.Logger

	ProxyQueryService query.ProxyQueryService

	CompilerMappings flux.CompilerMappings
	DialectMappings  flux.DialectMappings
}

// NewProxyQueryHandler returns a new instance of ProxyQueryHandler.
func NewProxyQueryHandler() *ProxyQueryHandler {
	h := &ProxyQueryHandler{
		Router: NewRouter(),
	}

	h.HandlerFunc("POST", proxyQueryPath, h.handlePostQuery)
	return h
}

// HTTPDialect is an encoding dialect that can write metadata to HTTP headers
type HTTPDialect interface {
	SetHeaders(w http.ResponseWriter)
}

// handlePostQuery handles query requests.
func (h *ProxyQueryHandler) handlePostQuery(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var req query.ProxyRequest
	req.WithCompilerMappings(h.CompilerMappings)
	req.WithDialectMappings(h.DialectMappings)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		EncodeError(ctx, err, w)
		return
	}

	hd, ok := req.Dialect.(HTTPDialect)
	if !ok {
		EncodeError(ctx, fmt.Errorf("unsupported dialect over HTTP %T", req.Dialect), w)
		return
	}
	hd.SetHeaders(w)

	n, err := h.ProxyQueryService.Query(ctx, w, &req)
	if err != nil {
		if n == 0 {
			// Only record the error headers IFF nothing has been written to w.
			EncodeError(ctx, err, w)
			return
		}
		h.Logger.Info("Error writing response to client",
			zap.String("handler", "transpilerde"),
			zap.Error(err),
		)
	}
}

// PrometheusCollectors satisifies the prom.PrometheusCollector interface.
func (h *ProxyQueryHandler) PrometheusCollectors() []prometheus.Collector {
	// TODO: gather and return relevant metrics.
	return nil
}

type ProxyQueryService struct {
	Addr               string
	Token              string
	InsecureSkipVerify bool
}

func (s *ProxyQueryService) Query(ctx context.Context, w io.Writer, req *query.ProxyRequest) (int64, error) {
	span, ctx := opentracing.StartSpanFromContext(ctx, "ProxyQueryService.Query")
	defer span.Finish()

	u, err := newURL(s.Addr, proxyQueryPath)
	if err != nil {
		return 0, tracing.LogError(span, err)
	}
	var body bytes.Buffer
	if err := json.NewEncoder(&body).Encode(req); err != nil {
		return 0, tracing.LogError(span, err)
	}

	hreq, err := http.NewRequest("POST", u.String(), &body)
	if err != nil {
		return 0, tracing.LogError(span, err)
	}
	SetToken(s.Token, hreq)
	hreq = hreq.WithContext(ctx)
	tracing.InjectToHTTPRequest(span, hreq)

	hc := newClient(u.Scheme, s.InsecureSkipVerify)
	resp, err := hc.Do(hreq)
	if err != nil {
		return 0, tracing.LogError(span, err)
	}
	defer resp.Body.Close()
	if err := CheckError(resp); err != nil {
		return 0, tracing.LogError(span, err)
	}
	n, err := io.Copy(w, resp.Body)
	if err != nil {
		return 0, tracing.LogError(span, err)
	}

	return n, nil
}
