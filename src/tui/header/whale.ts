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
