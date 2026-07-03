import { buildServer } from './server.ts'

const PORT = Number(process.env.PORT ?? 8787)
const { app } = buildServer()

app
  .listen({ port: PORT, host: '127.0.0.1' })
  .then(() => console.log(`veduta daemon (dev profile) → http://127.0.0.1:${PORT}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
