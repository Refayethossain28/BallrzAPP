/**
 * Atlas → Ray execution adapter.
 *
 * In the spec, step 6 is "Execution is sent through Ray" and step 7 is "Result
 * returns to Hermes". For the reliability-first MVP this is a deliberate STUB:
 * it does not import or require a running Ray cluster. It simulates a dispatch
 * so the whole path — Hermes → scheduler → node selection → execution → result
 * — is visible and testable end to end today.
 *
 * When Ray is wired up for real, replace `dispatch` with a call that submits the
 * task to a Ray actor/remote on the chosen node (e.g. via `ray job submit` or
 * the Ray client), keeping this same return shape. Nothing else has to change.
 */

/**
 * @param {object} node  the node the scheduler chose (canonical record)
 * @param {object} task  the task payload Hermes sent
 * @returns {Promise<object>} a result envelope destined for Hermes
 */
export async function dispatch(node, task) {
  // A real implementation would hand the task to Ray targeting `node.ip`.
  // The stub echoes enough for Hermes to confirm routing worked.
  return {
    ok: true,
    engine: 'ray-stub',
    ranOn: { id: node.id, hostname: node.hostname, ip: node.ip },
    task: task && typeof task === 'object' ? (task.name || task.type || 'task') : String(task ?? 'task'),
    note: 'Ray dispatch is stubbed in the MVP — selection is real, execution is simulated.',
  };
}
