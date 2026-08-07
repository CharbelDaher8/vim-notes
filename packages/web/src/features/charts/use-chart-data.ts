/**
 * The React half of `chart-data.ts`: fetches while a derived block is on screen.
 *
 * Mounted once, high in the tree. It fetches nothing until a widget subscribes,
 * so the overwhelming majority of notes -- the ones with no `source:` block --
 * cost exactly one `useState` and no request at all.
 */
import { useEffect, useState } from 'react'

import { accountCurrency } from '../budget/budget-model'
import { useBudgetDeclarations, useSpends } from '../budget/use-budget'
import { publishChartData, setChartDemandListener } from './chart-data'

export function useChartDataProvider(): void {
  const [demanded, setDemanded] = useState(false)

  useEffect(() => {
    setChartDemandListener(setDemanded)
    return () => setChartDemandListener(null)
  }, [])

  const spends = useSpends({ enabled: demanded })
  const declarations = useBudgetDeclarations({ enabled: demanded })

  const spendData = spends.data
  const declarationData = declarations.data

  useEffect(() => {
    if (spendData === undefined || declarationData === undefined) return

    publishChartData({
      spends: spendData,
      // Resolved once here rather than per block, so two charts in one note
      // cannot label their axes with different currencies.
      currency: accountCurrency(declarationData, spendData),
    })
  }, [spendData, declarationData])
}
