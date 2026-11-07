const identifier = /^[a-z][a-z0-9-]{0,47}$/;
const text = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Scenario ${field} must be non-empty text`);
  return value;
};

/** Small declarative contract, shared by the picker, model and tests; no central scene switch. */
export function createScenarioCatalog(definitions) {
  if (!Array.isArray(definitions) || !definitions.length) throw new TypeError('At least one scenario is required');
  const catalog = Object.create(null);
  for (const item of definitions) {
    if (!item || !identifier.test(item.id || '')) throw new TypeError('Scenario id must be a lowercase identifier');
    if (Object.hasOwn(catalog, item.id)) throw new TypeError(`Duplicate scenario id: ${item.id}`);
    const scenario = {
      id: item.id,
      title: text(item.title, 'title'),
      description: text(item.description, 'description'),
      symbol: text(item.symbol || '↗', 'symbol'),
      prompt: text(item.prompt, 'prompt'),
      reply: text(item.reply, 'reply'),
      longPlayback: item.longPlayback === true,
    };
    if (item.clarification) scenario.clarification = Object.freeze({
      prompt: text(item.clarification.prompt, 'clarification.prompt'),
      reply: text(item.clarification.reply, 'clarification.reply'),
    });
    if (item.background) scenario.background = Object.freeze({
      title: text(item.background.title, 'background.title'),
      body: text(item.background.body, 'background.body'),
    });
    catalog[item.id] = Object.freeze(scenario);
  }
  return Object.freeze(catalog);
}
