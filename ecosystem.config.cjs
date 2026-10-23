// PM2 config for the GDT demo server (other settings come from .env via dotenv).
module.exports = {
  apps: [
    {
      name: 'demo-api-gdt',
      script: 'server.js',
      cwd: __dirname,
      // Rate limit is in-memory, so keep a single instance. Never add --mock here.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      time: true,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
}
