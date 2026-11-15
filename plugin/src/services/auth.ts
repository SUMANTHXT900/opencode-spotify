import { createHmac, timingSafeEqual } from "node:crypto"

export const HANDSHAKE = "auto-1"
export const nonceValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
export function proof(secret: string, side: "server" | "client", role: string, client: string, server: string) {
  return createHmac("sha256", secret).update(`${HANDSHAKE}:${side}:${role}:${client}:${server}`).digest("hex")
}
export function verifyProof(expected: string, actual: unknown) {
  return nonceValid(actual) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))
}
export function boundedJson(raw: string) {
  const value: unknown = JSON.parse(raw)
  let count = 0
  function check(v: unknown, depth: number) {
    if (++count > 100_000 || depth > 24) throw new Error("Payload too complex")
    if (v && typeof v === "object") for (const child of Object.values(v)) check(child, depth + 1)
  }
  check(value, 0)
  return value
}
