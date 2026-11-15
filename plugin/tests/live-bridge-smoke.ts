// Optional short-lived receiver startup diagnostic; this does not expose credentials
// or prove live Spotify integration. Use the actual OpenCode TUI for
// authenticated live tests. Requires approved provisioning first.
import { SpicetifyServer } from "../src/services/SpicetifyServer.ts"

const server = new SpicetifyServer()
try {
  await server.start()
  if (server.state.connection !== "error") {
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  console.log(JSON.stringify({
    connection: server.state.connection,
    receivedTrack: server.state.track !== null,
    receivedCapabilities: server.state.capabilities !== null,
    error: server.state.error,
  }))
} finally {
  await server.stop()
}
