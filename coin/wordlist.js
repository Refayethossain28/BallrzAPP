/* BallrzCoin recovery-phrase wordlist — 256 curated English words.
 * One word encodes one byte, so a 32-byte private key becomes a 32-word phrase
 * (plus a checksum word). Order is fixed and MUST NOT be reordered — the index
 * of each word (0..255) is its byte value. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.BallrzWords = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return [
    'able','again','alpha','apron','atom','axis','banjo','berry',
    'bloom','brick','bunny','candy','cedar','chess','cider','clean',
    'cloud','cobra','cold','corn','crab','creek','crumb','curve',
    'debit','demon','diner','donut','drain','drink','dune','earth',
    'edge','elite','enemy','envy','evil','fabric','fang','fern',
    'fifth','first','flame','flint','focus','food','frame','front',
    'fungus','gala','gauge','ghost','glass','glove','golf','grace',
    'gravel','grill','grove','guest','gust','hammer','haste','heart',
    'herb','hippo','holy','horn','house','humor','hymn','igloo',
    'inlet','ivory','jar','jog','judge','jungle','keep','kind',
    'knee','labor','lagoon','large','lawn','lean','lens','limit',
    'liver','local','loop','lower','lunch','magnet','mango','margin',
    'mason','medal','merry','might','mint','mobile','mole','moral',
    'mound','mule','myth','nasal','nectar','never','nod','note',
    'nylon','office','olive','opal','organ','oven','paddle','pale',
    'papaya','parrot','pause','pecan','pepper','phone','pillar','pirate',
    'plane','plow','poem','police','porch','pound','press','prize',
    'prune','pulse','push','quart','quiet','quota','rail','ranch',
    'rash','read','red','relax','resin','rhyme','rigid','risk',
    'roast','rogue','root','route','rug','rush','safe','salmon',
    'sample','scale','scone','scrap','season','seed','sense','seven',
    'shawl','shirt','shrimp','sift','singer','size','skip','slab',
    'sling','smart','snack','sniff','sock','solid','sooth','source',
    'speak','spike','spleen','spool','spring','stack','stand','steel',
    'stiff','stomp','stream','stuff','sugar','super','swab','swear',
    'switch','tacos','tan','tart','teal','tent','theme','thorn',
    'thyme','tiger','timid','toast','tomato','topic','tower','tram',
    'tremor','trim','trout','truth','tundra','turkey','tux','tycoon',
    'umbra','unify','unwrap','upset','usher','valley','vast','vendor',
    'very','vial','vine','visa','vivid','volley','wafer','wall',
    'warm','water','wedge','west','whisk','widow','wind','wire',
    'wonder','worm','wreath','yacht','year','yodel','yoyo','zinc'
  ];
});
