import type { PantryApi } from './index'

declare global {
  interface Window {
    pantry: PantryApi
  }
}

export {}
