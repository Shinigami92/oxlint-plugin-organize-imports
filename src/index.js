import { definePlugin } from '@oxlint/plugins';
import { organizeImportsRule } from './rule.js';

export default definePlugin({
  meta: { name: 'organize-imports' },
  rules: { 'organize-imports': organizeImportsRule },
});
