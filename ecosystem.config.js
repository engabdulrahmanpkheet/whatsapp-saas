module.exports = {
  apps: [
    {
      name: 'whatsapp-saas-api',
      cwd: './server',
      script: 'app.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '500M',
    },
  ],
};
