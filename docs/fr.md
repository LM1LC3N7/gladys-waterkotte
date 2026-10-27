# Waterkotte

Affiche une pompe à chaleur Waterkotte dans Gladys par l'interface web locale
de sa régulation (EcoTouch, ou l'ancienne EasyCon), sans cloud. Non officiel :
sans lien avec Waterkotte. **Jamais testé avec une vraie pompe à chaleur** :
écrit à partir de l'intégration Home Assistant libre
[ha-waterkotte](https://github.com/marq24/ha-waterkotte) et testé avec une
régulation simulée. Merci de signaler ce que vous voyez sur la vôtre.

## Ce que vous obtenez

Un appareil, « Pompe à chaleur Waterkotte », avec ce que sa régulation donne :

- températures : extérieure, départ, retour et consigne de retour,
  température demandée (chauffage), entrée et sortie source, ballon tampon,
  pièce (si une sonde est branchée), eau chaude et température demandée
  (eau chaude) ;
- compresseur en marche, production d'eau chaude, alarme ;
- puissance électrique (kW), puissance thermique (kW), COP ;
- **Chauffage** et **Eau chaude** : Arrêt, Auto ou Manuel ;
- **Consigne d'eau chaude** (°C).

Les valeurs sont lues toutes les 60 secondes (30 à 600, dans la configuration).

## Mise en place

1. Trouvez l'adresse IP de la pompe à chaleur (sa page web) et donnez-lui une
   adresse fixe dans votre routeur.
2. Dans Gladys, ouvrez la configuration de l'intégration : saisissez
   l'adresse, choisissez la régulation (**EcoTouch** si la page web demande un
   mot de passe, même si elle affiche « EasyCon » ; **EasyCon** pour les
   anciennes régulations sans page de connexion), le nom d'utilisateur
   (`waterkotte` sauf si votre installateur l'a changé) et le mot de passe de
   la page web. Enregistrez.
3. Ajoutez la pompe à chaleur depuis l'onglet **Découverte**.

Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché, envoyé
seulement à la pompe à chaleur. La page web est en HTTP simple : gardez la
pompe à chaleur sur un réseau de confiance.

### Sessions

La régulation accepte peu de sessions à la fois (deux selon ha-waterkotte ;
sa page web ouverte dans un navigateur en prend une) et ferme une session
inactive après 5 minutes environ : après un redémarrage de Gladys, l'ancienne
session peut rester prise aussi longtemps. Gladys garde une seule session
ouverte, la ferme quand il s'arrête ou quand la configuration change, et se
reconnecte au plus une fois par lecture ou par commande, jamais en boucle.
Quand la régulation répond « trop d'utilisateurs », Gladys fait une pause de
1 minute, puis 2, 4… jusqu'à 6 heures, et l'indique dans l'écran de
configuration. Quand elle refuse le nom d'utilisateur ou le mot de passe,
Gladys arrête d'essayer : corrigez-les puis enregistrez, ou cliquez sur
**Tester la connexion** (un essai par clic).

## Commandes

L'**Arrêt** (chauffage ou eau chaude) est une commande de mise à l'arrêt :
il ne dépend ni de l'option « Autoriser les commandes », ni d'une pause, ni
d'une lecture en cours. Il est écrit, puis relu :

- relu à l'Arrêt : fait ;
- sinon Gladys répond « non envoyé », « envoyé, sans confirmation » ou « pas
  encore appliqué », garde l'arrêt (y compris après un redémarrage) et
  l'écrit avec les lectures suivantes : réécrit 3 fois au plus, et abandonné
  15 minutes après le clic quelles que soient les lectures. Une fois écrit,
  il n'est pas réécrit par-dessus une valeur réglée après le clic par
  quelqu'un d'autre (sur la régulation, sa page web) ; une commande plus
  ancienne de Gladys ne compte pas. Pendant une pause, l'arrêt a encore
  3 essais au plus.

L'Arrêt est refusé, rien n'est envoyé, dans ces cas seulement :

- la régulation est une EasyCon (lecture seule dans cette intégration) ;
- l'adresse ou le mot de passe manque : l'arrêt est gardé et écrit dès que la
  configuration est complète (15 minutes au plus) ;
- la pompe à chaleur a refusé les identifiants auparavant : l'arrêt est gardé
  et écrit dès leur correction (15 minutes au plus) ;
- rien n'a pu être écrit en 3 secondes (pas de réponse, réseau coupé,
  connexion refusée « trop d'utilisateurs ») : l'arrêt est gardé et écrit
  par les lectures suivantes.

**Auto**, **Manuel** et la **consigne d'eau chaude** sont refusés tant que
vous n'activez pas **Autoriser les commandes** (désactivé par défaut).
Ensuite :

- la consigne d'eau chaude prend des degrés entiers de 28 °C au plafond de la
  configuration, **55 °C par défaut**, de 40 à 60 °C (jamais plus de 60 °C,
  quoi qu'on saisisse) : risque de brûlure ;
- chaque commande lit la valeur et le numéro de série de la pompe à chaleur
  juste avant d'écrire, et ne réussit que si une relecture montre la valeur
  demandée ;
- une commande refusée ou annulée dit « rien envoyé » ; une commande partie
  sans réponse dit « envoyée, sans confirmation » et la valeur est relue 5 et
  20 secondes plus tard ;
- une commande cliquée avant un Arrêt de la même valeur (ou une consigne
  d'eau chaude cliquée avant un Arrêt de l'eau chaude) ne part jamais après
  lui.

L'intégration n'a aucun interrupteur : un « tout éteindre » d'un assistant
vocal ou d'une scène n'atteint pas la pompe à chaleur.

## Limites

- Une pompe à chaleur par intégration. Son numéro de série est vérifié à
  chaque lecture et avant chaque commande : si une autre pompe à chaleur
  répond à l'adresse, rien n'est publié et les commandes autres que l'Arrêt
  sont refusées.
- La régulation répond à une requête à la fois : si elle est lente (plus
  d'une demi-seconde environ par requête), une scène qui change plusieurs
  valeurs d'un coup peut voir les dernières refusées « pas de réponse à
  temps : rien envoyé ».
- EasyCon : lecture seule, et ses tags sont ceux d'EcoTouch (non vérifiés).
- La liste des tags vient de ha-waterkotte ; Waterkotte n'en publie pas.

## Remerciements

Construit sur le travail de Matthias Marquardt et des contributeurs de
[ha-waterkotte](https://github.com/marq24/ha-waterkotte) (MIT).
