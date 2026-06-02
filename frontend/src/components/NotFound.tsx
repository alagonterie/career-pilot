import { Link } from '@tanstack/react-router'

export function NotFound() {
  return (
    <div className="p-4">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <Link to="/" className="underline">
        Go home
      </Link>
    </div>
  )
}
