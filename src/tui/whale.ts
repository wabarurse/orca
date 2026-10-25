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

/** Pure presentation: a slow tail stroke, with no state or provider work. */
export function whaleRows(cols: number, budget: number, time = 0, active = false): string[] {
  const art = budget >= reference.length && cols >= 84 ? reference
    : budget >= compact.length && cols >= 44 ? compact
    : budget >= small.length && cols >= 32 ? small : undefined;
  if (!art) return [];
  const width = Math.max(...art.map(row => row.length));
  const stroke = active ? Math.round(Math.sin(time / 800)) : 0;
  const indent = Math.floor((cols - width) / 2);
  return art.map((line, row) => {
    const cells = Array<string>(cols).fill(" ");
    for (let col = 0; col < line.length; col++) {
      if (line[col] === " ") continue;
      const tail = row >= art.length - 2 && col < width * .25 ? stroke : 0;
      cells[indent + col + tail] = line[col]!;
    }
    return cells.join("");
  });
}
