import { z } from 'zod'

export const serviceTypeSchema = z.enum(['cable', 'broadband'])

export function normalizeArea(value: string) {
  return value.trim().normalize('NFC').toLocaleLowerCase().replace(/\s+/g, ' ')
}

export function body<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value)
}
