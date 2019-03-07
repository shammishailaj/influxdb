// Utils
import {valueFetcher, ValueFetcher} from 'src/variables/utils/ValueFetcher'
import Deferred from 'src/utils/Deferred'
import {CancellationError} from 'src/types/promises'
import {getVarAssignment} from 'src/variables/utils/getVarAssignment'

// Constants
import {OPTION_NAME} from 'src/variables/constants/index'

// Types
import {RemoteDataState} from 'src/types'
import {
  VariableValues,
  VariableValuesByID,
  ValueSelections,
} from 'src/variables/types'
import {Variable} from '@influxdata/influx'

interface VariableNode {
  variable: Variable
  values: VariableValues
  parents: VariableNode[]
  children: VariableNode[]
  status: RemoteDataState
  cancel?: () => void
}

interface HydrateVarsOptions {
  url: string
  orgID: string
  selections: ValueSelections
  fetcher: ValueFetcher
}

const invalidateCycles = (graph: VariableNode[]): void => {}

export const createVariableGraph = (
  variables: Variable[],
  allVariables: Variable[]
): VariableNode[] => {
  const nodesByID: {[variableID: string]: VariableNode} = {}

  for (const variable of allVariables) {
    nodesByID[variable.id] = {
      variable,
      values: null,
      parents: [],
      children: [],
      status: RemoteDataState.NotStarted,
      cancel: null,
    }
  }

  for (const variable of allVariables) {
    if (variable.arguments.type !== 'query') {
      continue
    }

    const query: string = variable.arguments.values.query
    const childIDs = allVariables
      .filter(maybeChild => query.includes(`${OPTION_NAME}.${maybeChild.name}`))
      .map(maybeChild => maybeChild.id)

    for (const childID of childIDs) {
      nodesByID[variable.id].children.push(nodesByID[childID])
      nodesByID[childID].parents.push(nodesByID[variable.id])
    }
  }

  const relevantSubGraph = Object.values(nodesByID).filter(
    node =>
      variables.includes(node.variable) ||
      node.parents.some(parent => variables.includes(parent.variable))
  )

  invalidateCycles(relevantSubGraph)

  return relevantSubGraph
}

const errorVariableValues = (): VariableValues => ({
  values: null,
  selectedValue: null,
  valueType: null,
  error: 'Failed to load values for variable',
})

const mapVariableValues = (
  variable: Variable,
  prevSelection: string,
  defaultSelection: string
): VariableValues => ({})

const constVariableValues = (
  variable: Variable,
  prevSelection: string,
  defaultSelection: string
): VariableValues => ({})

const collectDescendants = (node: VariableNode, acc = []): VariableNode[] => {
  for (const child of node.children) {
    acc.push(child)
    collectDescendants(child)
  }

  return acc
}

const hydrateVarsHelper = async (
  node: VariableNode,
  options: HydrateVarsOptions
): Promise<VariableValues> => {
  if (node.status === RemoteDataState.Error) {
    return errorVariableValues()
  }

  const variableType = node.variable.arguments.type
  const defaultSelection = node.variable.selected[0]
  const prevSelection = options.selections[node.variable.id]

  if (variableType === 'map') {
    // TODO: Build VariableValues from constant/map variable data
    return mapVariableValues(node.variable, prevSelection, defaultSelection)
  }

  if (variableType === 'constant') {
    return constVariableValues(node.variable, prevSelection, defaultSelection)
  }

  const descendants = collectDescendants(node)
  const assignments = descendants.map(node => getVarAssignment(node.values))

  const {url, orgID} = options
  const {query} = node.variable.arguments.values
  const fetcher = options.fetcher || valueFetcher

  const request = fetcher.fetch(
    url,
    orgID,
    query,
    assignments,
    prevSelection,
    defaultSelection
  )

  node.cancel = request.cancel

  const values = await request.promise

  return values
}

const hasResolvedChildren = (parent: VariableNode): boolean =>
  parent.children.every(
    child =>
      child.status === RemoteDataState.Done ||
      child.status === RemoteDataState.Error
  )

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
      if (e instanceof CancellationError) {
        return
      }

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
