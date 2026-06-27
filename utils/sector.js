const { normalizeText } = require('./normalize');

const SECTOR_VOCAB = {
  btp:          { lieu:'chantier',     lieux:'chantiers',       agent:'ouvrier',          agents:'ouvriers',         tache:'réserve',          rapport:'rapport chantier' },
  sante:        { lieu:'service',      lieux:'services',        agent:'soignant',         agents:'soignants',        tache:'soin/transmission',rapport:'transmission' },
  medical:      { lieu:'service',      lieux:'services',        agent:'soignant',         agents:'soignants',        tache:'soin/transmission',rapport:'transmission' },
  police:       { lieu:'secteur',      lieux:'secteurs',        agent:'agent',            agents:'agents',           tache:'patrouille',       rapport:'main courante' },
  pompiers:     { lieu:'caserne',      lieux:'casernes',        agent:'pompier',          agents:'pompiers',         tache:'garde',            rapport:'compte-rendu' },
  securite:     { lieu:'site surveillé',lieux:'sites surveillés',agent:'agent',           agents:'agents',           tache:'ronde',            rapport:'main courante' },
  nettoyage:    { lieu:'site client',  lieux:'sites clients',   agent:'agent',            agents:'agents',           tache:'prestation',       rapport:'contrôle qualité' },
  maintenance:  { lieu:'équipement',   lieux:'équipements',     agent:'technicien',       agents:'techniciens',      tache:'intervention',     rapport:'rapport intervention' },
  transport:    { lieu:'tournée',      lieux:'tournées',        agent:'chauffeur',        agents:'chauffeurs',       tache:'livraison',        rapport:'rapport tournée' },
  logistique:   { lieu:'entrepôt',     lieux:'entrepôts',       agent:'cariste',          agents:'caristes',         tache:'expédition',       rapport:'rapport logistique' },
  social:       { lieu:'établissement',lieux:'établissements',  agent:'travailleur social',agents:'travailleurs sociaux',tache:'suivi',         rapport:'compte-rendu' },
  restauration: { lieu:'service',      lieux:'services',        agent:'serveur',          agents:'équipe salle',     tache:'service',          rapport:'rapport service' },
  hotellerie:   { lieu:'chambre',      lieux:'chambres',        agent:'réceptionniste',   agents:'équipe hôtel',     tache:'ménage/réception', rapport:'rapport hôtel' },
  commerce:     { lieu:'boutique',     lieux:'boutiques',       agent:'vendeur',          agents:'vendeurs',         tache:'vente',            rapport:'rapport ventes' },
  education:    { lieu:'classe',       lieux:'classes',         agent:'enseignant',       agents:'enseignants',      tache:'cours',            rapport:'compte-rendu' },
  agriculture:  { lieu:'parcelle',     lieux:'parcelles',       agent:'ouvrier agricole', agents:'ouvriers',         tache:'travaux',          rapport:'rapport travaux' },
  funeraire:    { lieu:'cérémonie',    lieux:'cérémonies',      agent:'agent funéraire',  agents:'équipe',           tache:'cérémonie',        rapport:'compte-rendu' },
  industrie:    { lieu:'atelier',      lieux:'ateliers',        agent:'opérateur',        agents:'opérateurs',       tache:'production',       rapport:'rapport production' },
};

const PLACE_TYPE_MAP = {
  btp:'Chantier', sante:'Service', medical:'Service', police:'Secteur', pompiers:'Caserne',
  securite:'Site surveillé', nettoyage:'Site client', maintenance:'Équipement',
  transport:'Tournée', logistique:'Entrepôt', restauration:'Service', hotellerie:'Chambre/Étage',
  commerce:'Boutique', education:'Classe', agriculture:'Parcelle', funeraire:'Cérémonie',
  industrie:'Atelier', social:'Établissement',
};

function getSectorVocab(sector) {
  const s = normalizeText(sector || '');
  for (const [key, vocab] of Object.entries(SECTOR_VOCAB)) {
    if (s.includes(key)) return vocab;
  }
  return { lieu:'site', lieux:'sites', agent:'employé', agents:'employés', tache:'mission', rapport:'rapport' };
}

function getPlaceType(sector) {
  const s = normalizeText(sector || '');
  for (const [key, type] of Object.entries(PLACE_TYPE_MAP)) {
    if (s.includes(key)) return type;
  }
  return 'Site';
}

module.exports = { getSectorVocab, getPlaceType };
