/**
 * ESLint plugin enforcing blueprint rule 7.1.1 / R31:
 * money never passes through a JavaScript `number` for authoritative
 * calculation or display.
 *
 * Bans `Number(x)`, `parseFloat(x)`, `parseInt(x)` and unary `+x` when `x`
 * names money-like data (`amount`, `balance`, `value`, `rate`, `price`,
 * `total`, alone or as the tail of a compound name such as `fromAmount`).
 */

const MONEY_NAME = /(^|[a-z0-9_])(amount|balance|value|rate|price|total)s?$/i;

const isMoneyName = (name) => typeof name === 'string' && MONEY_NAME.test(name);

/** Best-effort name of the expression a coercion is applied to. */
function coercedName(node) {
  if (!node) return undefined;
  switch (node.type) {
    case 'Identifier':
      return node.name;
    case 'MemberExpression':
      if (!node.computed && node.property.type === 'Identifier') return node.property.name;
      if (node.computed && node.property.type === 'Literal') return String(node.property.value);
      return undefined;
    case 'CallExpression':
      return coercedName(node.callee);
    case 'AwaitExpression':
      return coercedName(node.argument);
    case 'TSNonNullExpression':
    case 'TSAsExpression':
      return coercedName(node.expression);
    default:
      return undefined;
  }
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow coercing money-like values to a JavaScript number (blueprint 7.1.1, R31).',
    },
    schema: [],
    messages: {
      coercion:
        'Money must never pass through a JavaScript number ("{{name}}"). Use Decimal/Money helpers, or format from the exact decimal string (blueprint 7.1.1).',
    },
  },
  create(context) {
    const report = (node, name) => context.report({ node, messageId: 'coercion', data: { name } });

    return {
      CallExpression(node) {
        const callee = node.callee;
        const isBareCoercion =
          callee.type === 'Identifier' && ['Number', 'parseFloat', 'parseInt'].includes(callee.name);
        const isNumberMemberCoercion =
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'Number' &&
          callee.property.type === 'Identifier' &&
          ['parseFloat', 'parseInt'].includes(callee.property.name);
        if (!isBareCoercion && !isNumberMemberCoercion) return;
        const arg = node.arguments[0];
        const name = coercedName(arg);
        if (isMoneyName(name)) report(node, name);
      },
      UnaryExpression(node) {
        if (node.operator !== '+') return;
        const name = coercedName(node.argument);
        if (isMoneyName(name)) report(node, name);
      },
    };
  },
};

export default {
  meta: { name: '@vaultide/eslint-plugin-money', version: '0.0.0' },
  rules: { 'no-number-coercion': rule },
};
