// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and option names, the status
// of the integration, the answers of the button and the command errors.
// Never a password, a cookie nor a value typed by the user beyond the
// (bounded, cleaned) address.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages; 59.99 s is "1 min", never "60 s". */
export function age(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.ceil(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

/** Joins texts (or plain strings) with a separator, in both languages. */
export function join(parts, separator = ' ') {
  const list = parts.filter(Boolean).map((p) => (typeof p === 'string' ? both(p, p) : p));
  return both(list.map((p) => p.en).join(separator), list.map((p) => p.fr).join(separator));
}

export const DEVICE_NAME = both('Waterkotte heat pump', 'Pompe à chaleur Waterkotte');

export const FEATURE_NAMES = {
  [FEATURES.HEATING_MODE]: both('Heating', 'Chauffage'),
  [FEATURES.DHW_MODE]: both('Hot water', 'Eau chaude'),
  [FEATURES.DHW_SETPOINT]: both('Hot water setpoint', "Consigne d'eau chaude"),
  [FEATURES.TEMP_OUTDOOR]: both('Outside temperature', 'Température extérieure'),
  [FEATURES.TEMP_FLOW]: both('Flow temperature', 'Température de départ'),
  [FEATURES.TEMP_RETURN]: both('Return temperature', 'Température de retour'),
  [FEATURES.TEMP_RETURN_TARGET]: both('Return temperature target', 'Consigne de retour'),
  [FEATURES.TEMP_HEATING_DEMAND]: both(
    'Heating demand temperature',
    'Température demandée (chauffage)',
  ),
  [FEATURES.TEMP_SOURCE_IN]: both('Source inlet temperature', 'Température entrée source'),
  [FEATURES.TEMP_SOURCE_OUT]: both('Source outlet temperature', 'Température sortie source'),
  [FEATURES.TEMP_BUFFER]: both('Buffer tank temperature', 'Température du ballon tampon'),
  [FEATURES.TEMP_ROOM]: both('Room temperature', 'Température de la pièce'),
  [FEATURES.TEMP_DHW]: both('Hot water temperature', "Température de l'eau chaude"),
  [FEATURES.TEMP_DHW_DEMAND]: both(
    'Hot water demand temperature',
    'Température demandée (eau chaude)',
  ),
  [FEATURES.POWER_ELECTRIC]: both('Electric power', 'Puissance électrique'),
  [FEATURES.POWER_HEATING]: both('Heat output (kW)', 'Puissance thermique (kW)'),
  [FEATURES.COP]: both('COP', 'COP'),
  [FEATURES.COMPRESSOR]: both('Compressor running', 'Compresseur en marche'),
  [FEATURES.DHW_ACTIVE]: both('Heating hot water', "Production d'eau chaude"),
  [FEATURES.ALARM]: both('Alarm', 'Alarme'),
};

export const OPERATION_NAMES = {
  off: both('Off', 'Arrêt'),
  auto: both('Auto', 'Auto'),
  manual: both('Manual', 'Manuel'),
};

const REASONS = {
  unreachable: both('no answer', 'pas de réponse'),
  timeout: both('no answer in time', 'pas de réponse à temps'),
  closed: both('connection closed', 'connexion fermée'),
  protocol: both('unexpected answer', 'réponse inattendue'),
  'too-large': both('answer too large', 'réponse trop grande'),
  late: both('too late', 'trop tard'),
  aborted: both('stopped', 'interrompu'),
  needLogin: both('session lost', 'session perdue'),
  serverError: both('server error', 'erreur du serveur'),
  httpStatus: both('unexpected HTTP status', 'statut HTTP inattendu'),
  tooManyUsers: both('too many sessions', 'trop de sessions'),
  badPassword: both('credentials refused', 'identifiants refusés'),
  preempted: both('interrupted by a stop', 'interrompu par un arrêt'),
};

/** A reason (src/http.js, src/client.js) in both languages, never a path nor a header. */
export function reasonText(reason) {
  const key = String(reason ?? '').split(' ')[0];
  return REASONS[key] ?? both('error', 'erreur');
}

/** Status texts of the configuration screen. */
export const T = {
  noAddress: both(
    'Enter the IP address of the heat pump (its web page) in the configuration.',
    "Saisissez l'adresse IP de la pompe à chaleur (sa page web) dans la configuration.",
  ),
  invalid: (typed) =>
    both(`"${typed}" is not a valid address.`, `« ${typed} » n'est pas une adresse valide.`),
  credentials: {
    missing: both(
      'Enter the password of the web page of the heat pump.',
      'Saisissez le mot de passe de la page web de la pompe à chaleur.',
    ),
    noUser: both(
      'A password needs a user name: enter both.',
      "Un mot de passe sans nom d'utilisateur est refusé : saisissez les deux.",
    ),
    invalid: both(
      'User name or password: 64 bytes at most, no control character.',
      "Nom d'utilisateur ou mot de passe : 64 octets au plus, sans caractère de contrôle.",
    ),
  },
  connecting: both('Connecting to the heat pump...', 'Connexion à la pompe à chaleur…'),
  configUnavailable: (wait) =>
    join([
      both(
        'The configuration could not be read from Gladys; next try in',
        'Configuration non lue depuis Gladys ; nouvel essai dans',
      ),
      wait,
    ]),
  connected: (model, serial, notes) =>
    join(
      [
        both(
          `Connected: ${model}${serial ? ` (serial ${serial})` : ''}.`,
          `Connecté : ${model}${serial ? ` (série ${serial})` : ''}.`,
        ),
        ...notes,
      ],
      ' ',
    ),
  unreachable: (address, reason, wait) =>
    join([
      both(`Heat pump ${address} unreachable:`, `Pompe à chaleur ${address} injoignable :`),
      reasonText(reason),
      both('; next try in', '; nouvel essai dans'),
      wait,
    ]),
  refused: both(
    'The heat pump refused the user name or the password: correct them and save, or click "Test the connection". No automatic retry.',
    "La pompe à chaleur a refusé le nom d'utilisateur ou le mot de passe : corrigez-les puis enregistrez, ou cliquez sur « Tester la connexion ». Aucun nouvel essai automatique.",
  ),
  tooManyUsers: (wait) =>
    join([
      both(
        'The controller has too many open sessions (its web page open elsewhere, another home automation system?); pause of',
        'La régulation a trop de sessions ouvertes (sa page web ouverte ailleurs, une autre domotique ?) ; pause de',
      ),
      wait,
    ]),
  serverError: (wait) =>
    join([
      both(
        'The heat pump answered with an error; pause of',
        'La pompe à chaleur a répondu par une erreur ; pause de',
      ),
      wait,
    ]),
  notes: {
    otherDevice: (serial) =>
      both(
        `Another heat pump answers at this address (serial ${serial}): its values are not published.`,
        `Une autre pompe à chaleur répond à cette adresse (série ${serial}) : ses valeurs ne sont pas publiées.`,
      ),
    identityUnreadable: both(
      'Serial number unreadable: the values are not published.',
      'Numéro de série illisible : les valeurs ne sont pas publiées.',
    ),
    stopsPending: both(
      'A stop is not confirmed yet: it is written again by the next reads.',
      "Un arrêt n'est pas encore confirmé : il est réécrit par les prochaines lectures.",
    ),
    storeUnreadable: both(
      '/data unreadable: it is not overwritten, the commands other than stop are refused.',
      '/data illisible : il n’est pas écrasé, les commandes autres que l’arrêt sont refusées.',
    ),
    easycon: both('EasyCon: read only.', 'EasyCon : lecture seule.'),
  },
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
    notYet: (wait) =>
      join([
        both(
          'Read less than an interval ago; next read in',
          "Lu il y a moins d'un intervalle ; prochaine lecture dans",
        ),
        wait,
      ]),
  },
};

/** Command errors (thrown, shown by Gladys in the user language of the configuration). */
export const ERRORS = {
  readOnly: both('This value cannot be changed.', 'Cette valeur ne se modifie pas.'),
  easyconReadOnly: both(
    'EasyCon is read only in this integration: nothing sent.',
    'EasyCon est en lecture seule dans cette intégration : rien envoyé.',
  ),
  badMode: both('Unknown choice: nothing sent.', 'Choix inconnu : rien envoyé.'),
  badNumber: both('Not a number: nothing sent.', "Ce n'est pas un nombre : rien envoyé."),
  badStep: both('Whole degrees only: nothing sent.', 'Degrés entiers seulement : rien envoyé.'),
  outOfRange: (min, max) =>
    both(`Between ${min} and ${max} °C: nothing sent.`, `Entre ${min} et ${max} °C : rien envoyé.`),
  dhwCap: (cap) =>
    both(
      `Above the hot water ceiling of ${cap} °C (configuration): nothing sent.`,
      `Au-dessus du plafond d'eau chaude de ${cap} °C (configuration) : rien envoyé.`,
    ),
  disabled: both(
    'Commands are disabled in the configuration ("Allow the commands"): nothing sent. Off does not depend on this option.',
    "Les commandes sont désactivées dans la configuration (« Autoriser les commandes ») : rien envoyé. L'arrêt ne dépend pas de cette option.",
  ),
  noConfig: both(
    'The heat pump is not configured (address, password): nothing sent.',
    "La pompe à chaleur n'est pas configurée (adresse, mot de passe) : rien envoyé.",
  ),
  credentialsRefused: both(
    'The heat pump refused the credentials: nothing sent. Correct them in the configuration.',
    'La pompe à chaleur a refusé les identifiants : rien envoyé. Corrigez-les dans la configuration.',
  ),
  paused: (wait) =>
    join([
      both(
        'The heat pump asked for a pause: nothing sent; it ends in',
        'La pompe à chaleur a demandé une pause : rien envoyé ; elle finit dans',
      ),
      wait,
    ]),
  stillRunning: both(
    'A command on this value is still running: nothing sent.',
    'Une commande sur cette valeur est en cours : rien envoyé.',
  ),
  stopPending: both(
    'Hot water was just turned off: the setpoint is not written until the stop is confirmed.',
    "L'eau chaude vient d'être arrêtée : la consigne n'est pas écrite tant que l'arrêt n'est pas confirmé.",
  ),
  cancelledByStop: both(
    'Cancelled by a later "Off": nothing sent.',
    'Annulée par un « Arrêt » plus récent : rien envoyé.',
  ),
  otherDevice: both(
    'Another heat pump answers at this address: nothing sent.',
    'Une autre pompe à chaleur répond à cette adresse : rien envoyé.',
  ),
  identityUnreadable: both(
    'The serial number of the heat pump could not be read: nothing sent.',
    'Le numéro de série de la pompe à chaleur est illisible : rien envoyé.',
  ),
  missingValue: both(
    'The current value could not be read: nothing sent.',
    "La valeur actuelle n'a pas pu être lue : rien envoyé.",
  ),
  unknownMode: (code) =>
    both(
      `The heat pump is in an unknown state (${code}): nothing sent.`,
      `La pompe à chaleur est dans un état inconnu (${code}) : rien envoyé.`,
    ),
  tooSlow: both(
    'The heat pump did not answer in time: nothing sent.',
    "La pompe à chaleur n'a pas répondu à temps : rien envoyé.",
  ),
  storeUnreadable: both(
    '/data is unreadable: nothing sent (only Off is allowed).',
    '/data est illisible : rien envoyé (seul l’arrêt est permis).',
  ),
  saveFailed: both(
    'The state could not be saved in /data: nothing sent.',
    "L'état n'a pas pu être enregistré dans /data : rien envoyé.",
  ),
  notSent: (reason) =>
    join([both('Nothing sent:', 'Rien envoyé :'), reasonText(reason), both('.', '.')], ''),
  sentUnconfirmed: (reason) =>
    join(
      [
        both('Sent, without confirmation (', 'Envoyée, sans confirmation ('),
        reasonText(reason),
        both('): checked again in 5 and 20 s.', ') : revérifiée dans 5 et 20 s.'),
      ],
      '',
    ),
  notYetApplied: both(
    'Sent, not applied yet: the heat pump still shows the previous value; checked again in 5 and 20 s.',
    "Envoyée, pas encore appliquée : la pompe à chaleur montre encore l'ancienne valeur ; revérifiée dans 5 et 20 s.",
  ),
  stop: {
    noConfig: both(
      'Off not sent: the heat pump is not configured. It is kept and written as soon as it is (15 min at most).',
      "Arrêt non envoyé : la pompe à chaleur n'est pas configurée. Il est gardé et écrit dès qu'elle l'est (15 min au plus).",
    ),
    refused: both(
      'Off not sent: the heat pump refused the credentials. It is kept and written once they are corrected (15 min at most).',
      'Arrêt non envoyé : la pompe à chaleur a refusé les identifiants. Il est gardé et écrit dès leur correction (15 min au plus).',
    ),
    notSent: (reason) =>
      join(
        [
          both('Off not sent (', 'Arrêt non envoyé ('),
          reasonText(reason),
          both('): written again by the next reads.', ') : réécrit par les prochaines lectures.'),
        ],
        '',
      ),
    unconfirmed: (reason) =>
      join(
        [
          both('Off sent, without confirmation (', 'Arrêt envoyé, sans confirmation ('),
          reasonText(reason),
          both(
            '): written again by the next reads if needed.',
            ') : réécrit par les prochaines lectures si besoin.',
          ),
        ],
        '',
      ),
    notYetApplied: both(
      'Off sent, not applied yet: written again by the next reads if needed.',
      'Arrêt envoyé, pas encore appliqué : réécrit par les prochaines lectures si besoin.',
    ),
  },
};
