// Utils
import {createVariableGraph} from 'src/variables/utils/hydrateVars'

// Types
import {RemoteDataState} from 'src/types'
import {Variable} from '@influxdata/influx'

const createVariable = (
  name: string,
  query: string,
  selected?: string
): Variable => ({
  name,
  id: name,
  orgID: 'howdy',
  selected: selected ? [selected] : [],
  arguments: {
    type: 'query',
    values: {
      query,
      language: 'flux',
    },
  },
})

describe('hydrate vars', () => {
  test('should be able to hydrate a graph', () => {})

  test('should be cancellable', () => {})

  test('should invalidate cyclic subgraphs', () => {})

  test('invalidateCycles', () => {
    // Create the following graph:
    //
    //     digraph{
    //       a -> b
    //       b -> c
    //       c -> a
    //       d
    //     }
    //
    const a = createVariable('a', 'foo(v: v.b)')
    const b = createVariable('b', 'foo(v: v.c)')
    const c = createVariable('c', 'foo(v: v.a)')
    const d = createVariable('d', 'foo(v: "howdy")')
    const vars = [a, b, c, d]
    const graph = createVariableGraph(vars, vars)

    expect(graph.find(n => n.variable === a).status).toBe(RemoteDataState.Error)
    expect(graph.find(n => n.variable === b).status).toBe(RemoteDataState.Error)
    expect(graph.find(n => n.variable === c).status).toBe(RemoteDataState.Error)
    expect(graph.find(n => n.variable === d).status).toBe(
      RemoteDataState.NotStarted
    )
  })
})
