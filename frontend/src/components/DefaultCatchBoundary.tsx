import { ErrorComponent, type ErrorComponentProps } from '@tanstack/react-router'

export function DefaultCatchBoundary({ error }: ErrorComponentProps) {
  return (
    <div className="p-4" role="alert">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <ErrorComponent error={error} />
    </div>
  )
}
