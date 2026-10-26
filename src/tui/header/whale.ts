// Killer-whale silhouette adapted from the user-provided ASCII reference.
const reference: readonly string[] = [
  "                                       #,",
  "                                       ###",
  "                                       ####",
  "                                       #####",
  "                                       ######",
  "                                      ########,",
  "                                ,,################,,,,,",
  "                          ,,#################################,,",
  "                     ,,##########################################,,",
  "                  ,#########################################, ''#####,",
  "               ,#############################################,,   '####,",
  "             ,##################################################,,,,####,",
  "           ,###########''''           ''''###############################",
  "         ,#####''   ,,,,##########,,,,          '''####'''          '####",
  "       ,##' ,,,,###########################,,,                        '##",
  "      ' ,,###''''                  '''############,,,",
  "    ,,##''                                '''############,,,,        ,,,,,,###''",
  " ,#''                                            '''#######################'''",
  "'                                                          ''''####''''"
];
const compact: readonly string[] = [
  "                   #,",
  "                   ###",
  "                   ####,",
  "             ,#################,",
  "       ,######################,  ###",
  "      ,#########################,,##,",
  "     ,######''     ''################",
  "   ,#',,##############,            ##",
  "  ,#'                '#######,,   ,,,##'",
  "'                            ''###''"
];

const small = [
  "              #,",
  "        ,,#########,,",
  "     ,################  ##,",
  "   ,####''    ''############",
  "  ,#' ,,#########,,      '##",
  " '          ''########,,##'",
];

/** Static new-chat artwork, sized to the available conversation viewport. */
export function whaleRows(cols: number, budget: number): string[] {
  const art = budget >= reference.length && cols >= 84 ? reference
    : budget >= compact.length && cols >= 44 ? compact
    : budget >= small.length && cols >= 32 ? small : undefined;
  if (!art) return [];
  const width = Math.max(...art.map(row => row.length));
  const indent = Math.floor((cols - width) / 2);
  return art.map(line => (" ".repeat(indent) + line).padEnd(cols));
}

/** A's cruising fin and light wake; shares the existing busy-conversation clock. */
export function finRows(cols: number, budget: number, time = 0, active = false): string[] {
  if (cols < 24 || budget < 6) return [];
  const tick = active ? Math.floor(time / 180) : 0;
  const grid = Array.from({ length: 6 }, () => Array<string>(cols).fill(" "));
  const travel = cols - 10, phase = (tick * .55) % (travel * 2);
  const x = 2 + Math.floor(phase < travel ? phase : travel * 2 - phase);
  for (let col = 0; col < cols; col++) grid[4]![col] = "~__~~_"[(col + Math.floor(tick / 2)) % 6]!;
  ["   #,", "   ###", "  #####"].forEach((line, row) => {
    for (let col = 0; col < line.length; col++) if (line[col] !== " ") grid[row + 1]![x + col] = line[col]!;
  });
  for (let col = x + 1; col < x + 7; col++) grid[4]![col] = "#";
  for (let distance = 2; distance < 9; distance += 3) if (x >= distance) grid[5]![x - distance] = ".";
  return grid.map(row => row.join(""));
}
