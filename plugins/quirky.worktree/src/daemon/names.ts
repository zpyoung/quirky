/** Marine creature names handed out for worktrees created without a name. */
export const MARINE_NAMES: readonly string[] = [
  'narwhal', 'octopus', 'manta', 'nautilus', 'dolphin', 'porpoise', 'orca', 'beluga', 'walrus',
  'seal', 'otter', 'manatee', 'dugong', 'whale', 'humpback', 'minke', 'sperm', 'shark',
  'hammerhead', 'mako', 'thresher', 'bullshark', 'tigershark', 'whaleshark',
  'blacktip', 'angelshark', 'dogfish', 'skate', 'stingray', 'eagleray', 'devilray',
  'sawfish', 'guitarfish', 'torpedo', 'electricray', 'lamprey', 'hagfish', 'sturgeon', 'tuna',
  'marlin', 'swordfish', 'sailfish', 'barracuda', 'wahoo', 'mahi', 'bonito', 'mackerel',
  'sardine', 'anchovy', 'herring', 'sprat', 'smelt', 'capelin', 'cod', 'haddock',
  'pollock', 'hake', 'halibut', 'flounder', 'sole', 'plaice', 'turbot', 'brill', 'dab', 'fluke',
  'grouper', 'snapper', 'bass', 'seabass', 'wrasse', 'parrotfish', 'surgeonfish', 'tang',
  'butterflyfish', 'angelfish', 'damselfish', 'clownfish', 'anemonefish', 'goby', 'blenny',
  'triggerfish', 'pufferfish', 'porcupinefish', 'boxfish', 'cowfish', 'filefish', 'lionfish',
  'scorpionfish', 'stonefish', 'frogfish', 'anglerfish', 'seahorse', 'pipefish', 'seadragon',
  'cuttlefish', 'squid', 'argonaut', 'vampiresquid', 'jellyfish', 'ctenophore',
  'portuguesemanowar', 'seawasp', 'siphonophore', 'anemone', 'coral', 'polyp', 'seafan', 'seapen',
  'urchin', 'starfish', 'brittlestar', 'seacucumber', 'sanddollar', 'crinoid', 'featherstar',
  'lobster', 'crab', 'shrimp', 'prawn', 'krill', 'crayfish', 'barnacle', 'limpet', 'abalone',
  'conch', 'whelk', 'cowrie', 'scallop', 'oyster', 'clam', 'mussel', 'cockle', 'geoduck',
  'nudibranch', 'seaslug', 'seahare', 'sponge', 'tunicate', 'seasquirt', 'lancelet', 'amphipod',
  'isopod', 'copepod', 'fiddler', 'horseshoe', 'ghostcrab',
  'kingcrab', 'dungeness', 'stonecrab', 'velella', 'pompano', 'tarpon',
  'bonefish', 'snook', 'mullet', 'remora', 'pilotfish', 'oarfish', 'ribbonfish', 'opah',
  'lanternfish', 'viperfish', 'gulper', 'fangtooth', 'dragonfish', 'hatchetfish', 'bristlemouth',
  'cusk', 'grenadier', 'rattail', 'whiting', 'wolffish', 'lumpfish',
  'sculpin', 'greenling', 'rockfish', 'sablefish', 'lingcod', 'saury', 'needlefish', 'halfbeak',
  'flyingfish', 'garfish', 'moray', 'conger', 'eel', 'gulpereel', 'sunfish', 'mola',
  'pomfret', 'trevally', 'amberjack', 'kingfish', 'yellowtail', 'dolphinfish',
  'bluefish', 'weakfish', 'drum', 'croaker', 'sheepshead', 'porgy', 'bream', 'tilefish',
  'batfish', 'cardinalfish', 'squirrelfish', 'soldierfish', 'bigeye', 'sweetlips', 'grunt',
  'emperor', 'threadfin', 'mojarra', 'jawfish', 'dartfish', 'firefish', 'hogfish', 'tuskfish',
  'razorfish', 'dottyback', 'basslet', 'hawkfish', 'anthias',
  'toadfish', 'midshipman', 'clingfish', 'stargazer', 'weever', 'thornback', 'ratfish',
  'chimaera', 'coelacanth', 'kelpfish', 'gar', 'pike', 'leatherback',
  'loggerhead', 'hawksbill', 'ridley', 'penguin', 'puffin', 'auk',
  'murre', 'albatross', 'petrel', 'shearwater', 'tern', 'gannet', 'booby', 'frigatebird',
  'cormorant', 'pelican', 'sealion', 'elephantseal', 'leopardseal',
  'nautilid', 'triton', 'murex', 'volute',
  'cerith', 'periwinkle', 'topshell', 'nerite', 'moonsnail',
  'slipper',
]

/**
 * Picks a generated worktree name uniformly at random among the names not in `unavailable`.
 *
 * When every name is unavailable, the same pick runs over the pool with `-2` appended to each
 * name, then `-3`, and so on, so the first tier with any free name always wins. `random` must
 * return a value in [0, 1).
 */
export function pickGeneratedName(
  unavailable: ReadonlySet<string>,
  random: () => number = Math.random,
): string {
  for (let tier = 1; ; tier++) {
    const suffix = tier === 1 ? '' : `-${tier}`
    const free = MARINE_NAMES.map((n) => `${n}${suffix}`).filter((n) => !unavailable.has(n))
    if (free.length > 0) return free[Math.floor(random() * free.length)]!
  }
}
