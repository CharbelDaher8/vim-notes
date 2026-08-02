/** Returned by every subscribe-style port method. Idempotent by contract. */
export type Unsubscribe = () => void
