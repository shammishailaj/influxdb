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

  return relevantSubGraph
}

/*
  Get the `VariableValues` for a variable that cannot be successfully hydrated.
*/
const errorVariableValues = (
  message = 'Failed to load values for variable'
): VariableValues => ({
  values: null,
  selectedValue: null,
  valueType: null,
  error: message,
})

/*
  Get the `VariableValues` for a map variable.
*/
const mapVariableValues = (
  variable: Variable,
  prevSelection: string,
  defaultSelection: string
): VariableValues => {
  let selectedValue

  const {values} = variable.arguments

  if (values[prevSelection] !== undefined) {
    selectedValue = values[prevSelection]
  } else if (values[defaultSelection] !== undefined) {
    selectedValue = values[defaultSelection]
  } else {
    selectedValue = Object.values(values)[0]
  }

  return {
    valueType: 'string',
    values: Object.values(values),
    selectedValue,
  }
}

/*
  Get the `VariableValues` for a constant variable.
*/
const constVariableValues = (
  variable: Variable,
  prevSelection: string,
  defaultSelection: string
): VariableValues => {
  let selectedValue

  const {values} = variable.arguments

  if (values.includes(prevSelection)) {
    selectedValue = prevSelection
  } else if (values.includes(defaultSelection)) {
    selectedValue = defaultSelection
  } else {
    selectedValue = values[0]
  }

  return {
    valueType: 'string',
    values,
    selectedValue,
  }
}

/*
  Given a node, find all of it's children, and all the children of those
  children... and so on.
*/
const collectDescendants = (node: VariableNode, acc = []): VariableNode[] => {
  for (const child of node.children) {
    acc.push(child)
    collectDescendants(child)
  }

  return acc
}

/*
  Hydrate the values of a single node in the graph.

  This assumes that every descendant of this node has already been hydrated. 
*/
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

/*
  Check if every child of a node has been resolved (successfully or not).
*/
const hasResolvedChildren = (parent: VariableNode): boolean =>
  parent.children.every(
    child =>
      child.status === RemoteDataState.Done ||
      child.status === RemoteDataState.Error
  )

/*
  Find all nodes in the graph that have no children.
*/
const findLeaves = (graph: VariableNode[]): VariableNode[] =>
  graph.filter(node => node.children.length === 0)

/*
  Given a node, attempt to find a cycle that the node is a part of. If no cycle
  is found, return `null`.
*/
const findCycle = (node: VariableNode, seen = []): VariableNode[] => {
  if (seen.includes(node)) {
    throw seen
  }

  for (const child of node.children) {
    try {
      findCycle(child, [...seen, node])
    } catch (cycle) {
      return cycle
    }
  }

  return null
}

/*
  Find all cycles within the variable graph and mark every node within a cycle
  as errored (we cannot resolve cycles).
*/
const invalidateCycles = (graph: VariableNode[]): void => {
  for (const node of graph) {
    const cycle = findCycle(node)

    if (cycle) {
      for (const invalidNode of cycle) {
        invalidNode.status === RemoteDataState.NotStarted
      }
    }
  }
}

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

  invalidateCycles(graph)

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

      // TODO: Mark every node in a path to this node as errored
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
