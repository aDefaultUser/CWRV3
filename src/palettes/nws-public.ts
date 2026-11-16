// Public NWS standard radar colour tables, as distributed by MetPy 1.7.1 (BSD-3-Clause, Copyright (c) 2008-2025
// MetPy Developers; licence text in ./METPY-LICENSE.txt): NWSReflectivityExpanded.tbl (labelled 5 … 75 dBZ) and
// NWSVelocity.tbl (range folded, then strongest inbound … strongest outbound). Every colour below comes from those tables.
// Velocity bins (the table carries no values) use the 16-level velocity
// boundaries −50 … +64 kt (implementation choice); reflectivity bins are flat 5 dBZ steps as labelled in the table.

/** Reflectivity, flat 5 dBZ bins from 5 dBZ; the second frame (700 ms) flashes ≥ 65 dBZ cores to the 75 dBZ white. */
export const NWS_REFLECTIVITY = `0,0,0,0;0,0,0,0|-30|
4,233,231,255;4,233,231,255|5|
1,159,244,255;1,159,244,255|10|
3,0,244,255;3,0,244,255|15|
2,253,2,255;2,253,2,255|20|
1,197,1,255;1,197,1,255|25|
0,142,0,255;0,142,0,255|30|
253,248,2,255;253,248,2,255|35|
229,188,0,255;229,188,0,255|40|
253,149,0,255;253,149,0,255|45|
253,0,0,255;253,0,0,255|50|
212,0,0,255;212,0,0,255|55|
188,0,0,255;188,0,0,255|60|
248,0,253,255;248,0,253,255|65|
152,84,198,255;152,84,198,255|70|
253,253,253,255|75`;

export const NWS_REFLECTIVITY_FLASH = `@700|1
${NWS_REFLECTIVITY.split('\n').slice(0, 13).join('\n')}
253,253,253,255;253,253,253,255|65|
253,253,253,255;253,253,253,255|70|
253,253,253,255|75`;

/** Velocity (kt code units): greens inbound, the two near-zero greys, reds outbound; ±64 kt and beyond saturate. */
export const NWS_VELOCITY = `0,255,0,255;0,255,0,255|-127|
0,232,0,255;0,232,0,255|-50|
0,200,0,255;0,200,0,255|-36|
0,176,0,255;0,176,0,255|-26|
0,144,0,255;0,144,0,255|-20|
0,112,0,255;0,112,0,255|-10|
119,151,119,255;119,151,119,255|-1|
151,119,119,255;151,119,119,255|0|
128,0,0,255;128,0,0,255|10|
160,0,0,255;160,0,0,255|20|
184,0,0,255;184,0,0,255|26|
216,0,0,255;216,0,0,255|36|
238,0,0,255;238,0,0,255|50|
255,0,0,255;255,0,0,255|64|
255,0,0,255|126`;
