// PM2 production config — start with:  pm2 start ecosystem.config.cjs
// PM2 restarts the app if it crashes; `pm2 save` + `pm2 startup` make it
// start again automatically after a server reboot.
//
// .cjs (not .js) is deliberate: package.json sets "type": "module", but
// PM2 config files use CommonJS (`module.exports`) regardless — the .cjs
// extension forces that interpretation.
module.exports = {
  apps: [
    {
      name: 'omni-backend',
      script: 'start.js',
      cwd: __dirname,

      env: {
        NODE_ENV: 'production',
      },

      // Restart behavior
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 20,
      min_uptime: '10s',
      max_memory_restart: '300M',

      // Logs: ~/.pm2/logs/omni-backend-out.log and omni-backend-error.log
      time: true,
    },
  ],
};
