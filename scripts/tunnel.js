// Runs `ngrok http --url=$NGROK_DOMAIN $PORT` with values read from .env (local testing only).
import { spawn } from 'child_process'
import dotenv from 'dotenv'

dotenv.config()

const port = String(process.env.PORT || 3040)
const domain = (process.env.NGROK_DOMAIN || '').trim()
const args = ['http', ...(domain ? [`--url=${domain}`] : []), port]

console.log(`> ngrok ${args.join(' ')}`)
const child = spawn('ngrok', args, { stdio: 'inherit' })
child.on('error', (err) => {
  console.error(err.code === 'ENOENT' ? 'Không tìm thấy ngrok — cài tại https://ngrok.com/download' : err.message)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 0))
