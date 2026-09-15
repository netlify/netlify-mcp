export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const isRelativeJsSpecifier = specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'));
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && isRelativeJsSpecifier) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw err;
  }
}
