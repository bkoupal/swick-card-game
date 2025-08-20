module.exports = {
  apps: [
    {
      name: "swick-backend",
      script: "./lib/index.js",
      instances: 1,
      exec_mode: "fork",
      env_file: "./.env.production",
      env: {
        NODE_ENV: "production",
        PORT: 2567,
        HOST: "0.0.0.0",
      },
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_file: "./logs/combined.log",
      time: true,
    },
  ],
};
