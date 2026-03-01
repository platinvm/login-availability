import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Merge Tailwind class names conditionally.
 * - Deduplicates conflicting Tailwind utilities via `tailwind-merge`.
 * - Accepts anything `clsx` accepts (strings, objects, arrays).
 * @param inputs List of class name values.
 * @returns A single optimized class name string.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
