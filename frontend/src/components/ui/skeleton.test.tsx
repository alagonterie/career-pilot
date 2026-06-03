import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Skeleton } from './skeleton'

describe('Skeleton (§24.36 36.1)', () => {
  it('renders a decorative, pulsing placeholder that screen readers skip', () => {
    const { container } = render(<Skeleton className="h-8 w-12" />)
    const el = container.querySelector('[data-slot="skeleton"]')
    expect(el).not.toBeNull()
    expect(el).toHaveAttribute('aria-hidden', 'true')
    expect(el).toHaveClass('animate-pulse')
    // caller classes merge through
    expect(el).toHaveClass('h-8', 'w-12')
  })
})
