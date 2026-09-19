import './style.css';
// @ts-ignore
import App from './main.vue';
import { createApp } from 'vue';
import { logger, installGlobalErrorHandlers } from '@/utils/logger';

installGlobalErrorHandlers();

const app = createApp(App);
app.config.errorHandler = (err, _vm, info) => {
  logger.error({
    tag: 'vue.error',
    message: String(err instanceof Error ? err.message : err),
    context: { info, stack: err instanceof Error ? err.stack : undefined },
  });
};
app.mount('#app')