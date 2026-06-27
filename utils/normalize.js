function normalizeText(value) {
  return String(value || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/['']/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeRole(role) {
  return normalizeText(role).replace(/\s+/g, '');
}

function canRoleEdit(role, isCreator = false) {
  if (isCreator) return true;
  const r = normalizeRole(role);
  return r === 'gerant' || r === 'rh' || r === 'ressourceshumaines' || r === 'responsablerh' || r === 'admin' || r === 'manager';
}

function canRoleManage(role, isCreator = false) {
  if (isCreator) return true;
  const r = normalizeRole(role);
  return r === 'gerant' || r === 'admin' || r === 'manager' || r === 'responsable' || r === 'rh';
}

module.exports = { normalizeText, normalizeRole, canRoleEdit, canRoleManage };
