// Utils
import {valueFetcher, ValueFetcher} from 'src/variables/utils/ValueFetcher'
import Deferred from 'src/utils/Deferred'
import {CancellationError} from 'src/types/promises'

// Types
import {RemoteDataState} from 'src/types'
import {
  VariableValues,
  VariableValuesByID,
  ValueSelections,
} from 'src/variables/types'
import {Variable} from '@influxdata/influx'

interface VariableNode {
  variable: Variable[]
  values: VariableValues
  parents: VariableNode[]
  children: VariableNode[]
  status: RemoteDataState
  cancel?: () => void
}

interface HydrateVarsOptions {
  orgID: string
  selections: ValueSelections
  fetcher: ValueFetcher
}

const createVariableGraph = (variables, allVariables): VariableNode[] => {}

const hydrateVarsHelper = (
  node: VariableNode,
  options: HydrateVarsOptions
): VariableValues => {}

const hasResolvedChildren = (parent: VariableNode) =>
  parent.children.every(child => child.status === RemoteDataState.Done)

const findLeaves = (graph: VariableNode[]): VariableNode[] =>
  graph.filter(node => node.children.length === 0)

/*
  Given a list of `variables`, execute their queries to retrieve the possible
  values for each variable.

  TODO: Document algorithm
*/
export const hydrateVars = (
  variables: Variable[],
  allVariables: Variable[],
  options: HydrateVarsOptions
): {cancel: () => void; promise: Promise<VariableValuesByID>} => {
  const graph = createVariableGraph(variables, allVariables)

  let isCancelled = false

  const resolve = async (node: VariableNode) => {
    if (isCancelled) {
      return
    }

    node.status === RemoteDataState.Loading

    try {
      node.values = await hydrateVarsHelper(node, options)
      node.status = RemoteDataState.Done

      return Promise.all(node.parents.filter(hasResolvedChildren).map(resolve))
    } catch (e) {
      // TODO: Handle cancellation
      // TODO: Handle other errors / mark every other node with a path to this node as an error and resolve
    }
  }

  const deferred = new Deferred()

  const cancel = () => {
    isCancelled = true

    graph.forEach(node => {
      if (node.cancel) {
        node.cancel()
      }
    })

    deferred.reject(new CancellationError())
  }

  Promise.all(findLeaves(graph).map(resolve)).then(() => {
    const result = {}

    for (const [id, {values}] of Object.entries(graph)) {
      result[id] = values
    }

    deferred.resolve(result)
  })

  return {promise: deferred.promise, cancel}
}
