// APIs
import {executeQueryWithVars} from 'src/shared/apis/query'

// Types
import {VariableAssignment} from 'src/types/ast'
import {VariableValues} from 'src/variables/types'

/*
  Given the CSV response for a Flux query, get the set of values across all
  `_value` columns in the response, as well as the column type of these values
  and a choice of selected value.

  The selected value must exist in the returned values for the response. We
  will first try to use the `prevSelection`, then the `defaultSelection`,
  before finally falling back to the first value returned in the response.

  If the response contains multiple different types for the `_value` columns,
  we will disregard all columns that have type different from the first column.
*/
const extractValues = (
  csv: string,
  defaultSelection: string,
  prevSelection: string
): VariableValues => {}

export class ValueFetcher {
  fetch(
    url: string,
    orgID: string,
    query: string,
    variables: VariableAssignment[],
    prevSelection: string,
    defaultSelection: string
  ): {cancel: () => void; promise: Promise<VariableValues>} {
    // TODO: Cache me!
    return executeQueryWithVars(url, orgID, query, variables)
  }
}

export const valueFetcher = new ValueFetcher()
