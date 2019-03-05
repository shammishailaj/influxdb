package ptrutil

import "time"

func Int64Ptr(i int64) *int64 {
	return &i
}

func DurationPtr(d time.Duration) *time.Duration {
	return &d
}
