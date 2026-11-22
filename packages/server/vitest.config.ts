import { defineConfig } from 'vitest/config';

// The tests use a fixed sample-town centre, whatever the runtime default is.
export default defineConfig({ test: { env: { CITY_CENTER: '27.4924,77.6737' } } });
