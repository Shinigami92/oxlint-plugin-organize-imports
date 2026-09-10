import { definePlugin } from '@oxlint/plugins';
import { organizeImportsRule } from './rule';

export type { Mode, RuleOptions } from './types';

export default definePlugin({
  meta: { name: 'organize-imports' },
  rules: { 'organize-imports': organizeImportsRule },
});
