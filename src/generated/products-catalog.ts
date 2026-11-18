// Runtime catalog of the radar products (Level 2, Level 3, Level 3 overlays and categories) and the Basic
// layers. Maintained by hand.
export const PRODUCTS = {
 "level3": [
  {
   "index": 0,
   "id": "l3.br.0",
   "name": "0.5° Base Reflectivity, 248nmi",
   "category": "Reflectivity",
   "tilt": "0.5",
   "ds": "p94r0",
   "code": 94,
   "awips": "N0Q",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 1,
   "id": "l3.dhr",
   "name": "Digital Hybrid-Scan Reflectivity",
   "category": "Reflectivity",
   "tilt": null,
   "ds": "32dhr",
   "code": 32,
   "awips": "DHR",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 2,
   "id": "l3.eet",
   "name": "Enhanced Echo Tops (Digital)",
   "category": "Reflectivity",
   "tilt": null,
   "ds": "135et",
   "code": 135,
   "awips": "EET",
   "disabled": false,
   "unit": "kft"
  },
  {
   "index": 3,
   "id": "l3.br.a",
   "name": "0.9° Base Reflectivity, 248nmi",
   "category": "Reflectivity",
   "tilt": "0.9",
   "ds": "p94ra",
   "code": 94,
   "awips": "NAQ",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 4,
   "id": "l3.br.1",
   "name": "~1.4° Base Reflectivity, 248nmi",
   "category": "Reflectivity",
   "tilt": "~1.4",
   "ds": "p94r1",
   "code": 94,
   "awips": "N1Q",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 5,
   "id": "l3.br.b",
   "name": "1.8° Base Reflectivity, 248nmi",
   "category": "Reflectivity",
   "tilt": "1.8",
   "ds": "p94rb",
   "code": 94,
   "awips": "NBQ",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 6,
   "id": "l3.br.2",
   "name": "~2.5° Base Reflectivity, 248nmi",
   "category": "Reflectivity",
   "tilt": "~2.5",
   "ds": "p94r2",
   "code": 94,
   "awips": "N2Q",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 7,
   "id": "l3.br.3",
   "name": "~3.4° Base Reflectivity, 248nmi",
   "category": "Reflectivity",
   "tilt": "~3.4",
   "ds": "p94r3",
   "code": 94,
   "awips": "N3Q",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 8,
   "id": "l3.cr124",
   "name": "Composite Reflectivity, 124nmi",
   "category": "Reflectivity",
   "tilt": null,
   "ds": "p37cr",
   "code": 37,
   "awips": "NCR",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 9,
   "id": "l3.cr248",
   "name": "Composite Reflectivity, 248nmi",
   "category": "Reflectivity",
   "tilt": null,
   "ds": "p38cr",
   "code": 38,
   "awips": "NCZ",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 10,
   "id": "l3.et",
   "name": "Echo Tops (Classic, 16-level)",
   "category": "Reflectivity",
   "tilt": null,
   "ds": "p41et",
   "code": 41,
   "awips": "NET",
   "disabled": false,
   "unit": "kft"
  },
  {
   "index": 11,
   "id": "l3.bv.0",
   "name": "0.5° Base Velocity, 162nmi",
   "category": "Velocity",
   "tilt": "0.5",
   "ds": "p99v0",
   "code": 99,
   "awips": "N0U",
   "disabled": false,
   "unit": "m/s"
  },
  {
   "index": 12,
   "id": "l3.bv.a",
   "name": "0.9° Base Velocity, 162nmi",
   "category": "Velocity",
   "tilt": "0.9",
   "ds": "p99va",
   "code": 99,
   "awips": "NAU",
   "disabled": false,
   "unit": "m/s"
  },
  {
   "index": 13,
   "id": "l3.bv.1",
   "name": "~1.4° Base Velocity, 162nmi",
   "category": "Velocity",
   "tilt": "~1.4",
   "ds": "p99v1",
   "code": 99,
   "awips": "N1U",
   "disabled": false,
   "unit": "m/s"
  },
  {
   "index": 14,
   "id": "l3.bv.b",
   "name": "1.8° Base Velocity, 162nmi",
   "category": "Velocity",
   "tilt": "1.8",
   "ds": "p99vb",
   "code": 99,
   "awips": "NBU",
   "disabled": false,
   "unit": "m/s"
  },
  {
   "index": 15,
   "id": "l3.bv.2",
   "name": "~2.5° Base Velocity, 162nmi",
   "category": "Velocity",
   "tilt": "~2.5",
   "ds": "p99v2",
   "code": 99,
   "awips": "N2U",
   "disabled": false,
   "unit": "m/s"
  },
  {
   "index": 16,
   "id": "l3.bv.3",
   "name": "~3.4° Base Velocity, 162nmi",
   "category": "Velocity",
   "tilt": "~3.4",
   "ds": "p99v3",
   "code": 99,
   "awips": "N3U",
   "disabled": false,
   "unit": "m/s"
  },
  {
   "index": 17,
   "id": "l3.srv.0",
   "name": "0.5° Storm Relative Velocity",
   "category": "Velocity",
   "tilt": "0.5",
   "ds": "56rm0",
   "code": 56,
   "awips": "N0S",
   "disabled": false,
   "unit": "kts"
  },
  {
   "index": 18,
   "id": "l3.srv.1",
   "name": "~1.4° Storm Relative Velocity",
   "category": "Velocity",
   "tilt": "~1.4",
   "ds": "56rm1",
   "code": 56,
   "awips": "N1S",
   "disabled": false,
   "unit": "kts"
  },
  {
   "index": 19,
   "id": "l3.srv.2",
   "name": "~2.5° Storm Relative Velocity",
   "category": "Velocity",
   "tilt": "~2.5",
   "ds": "56rm2",
   "code": 56,
   "awips": "N2S",
   "disabled": false,
   "unit": "kts"
  },
  {
   "index": 20,
   "id": "l3.srv.3",
   "name": "~3.4° Storm Relative Velocity",
   "category": "Velocity",
   "tilt": "~3.4",
   "ds": "56rm3",
   "code": 56,
   "awips": "N3S",
   "disabled": false,
   "unit": "kts"
  },
  {
   "index": 21,
   "id": "l3.sw",
   "name": "0.5° Base Spectrum Width, 124nmi",
   "category": "Spectrum Width",
   "tilt": "0.5",
   "ds": "p30sw",
   "code": 30,
   "awips": "NSW",
   "disabled": false,
   "unit": "kts"
  },
  {
   "index": 22,
   "id": "l3.dsp",
   "name": "Storm Total Precip (Digital)",
   "category": "Precipitation",
   "tilt": null,
   "ds": "138dp",
   "code": 138,
   "awips": "DSP",
   "disabled": true,
   "unit": "in"
  },
  {
   "index": 23,
   "id": "l3.dta",
   "name": "Digital Storm Total Accumulation",
   "category": "Precipitation",
   "tilt": null,
   "ds": "172dt",
   "code": 172,
   "awips": "DTA",
   "disabled": false,
   "unit": "in"
  },
  {
   "index": 24,
   "id": "l3.stp",
   "name": "Storm Total Rainfall (Legacy)",
   "category": "Precipitation",
   "tilt": null,
   "ds": "80stp",
   "code": 80,
   "awips": "NTP",
   "disabled": true,
   "unit": "in"
  },
  {
   "index": 25,
   "id": "l3.dvl",
   "name": "VIL (Digital High-resolution)",
   "category": "Precipitation",
   "tilt": null,
   "ds": "134il",
   "code": 134,
   "awips": "DVL",
   "disabled": false,
   "unit": "kg/m^2"
  },
  {
   "index": 26,
   "id": "l3.vil",
   "name": "VIL (Classic, 16-level)",
   "category": "Precipitation",
   "tilt": null,
   "ds": "57vil",
   "code": 57,
   "awips": "NVL",
   "disabled": false,
   "unit": "kg/m^2"
  },
  {
   "index": 27,
   "id": "l3.daa",
   "name": "One-Hour Accumulation (Unbiased)",
   "category": "Precipitation",
   "tilt": null,
   "ds": "170aa",
   "code": 170,
   "awips": "DAA",
   "disabled": false,
   "unit": "in"
  },
  {
   "index": 28,
   "id": "l3.oha",
   "name": "One-Hour Accumulation",
   "category": "Precipitation",
   "tilt": null,
   "ds": "169oh",
   "code": 169,
   "awips": "OHA",
   "disabled": false,
   "unit": "in"
  },
  {
   "index": 29,
   "id": "l3.ohp",
   "name": "One-Hour Rainfall (Legacy)",
   "category": "Precipitation",
   "tilt": null,
   "ds": "78ohp",
   "code": 78,
   "awips": "N1P",
   "disabled": true,
   "unit": "in"
  },
  {
   "index": 30,
   "id": "l3.thp",
   "name": "Three-Hour Rainfall (Legacy)",
   "category": "Precipitation",
   "tilt": null,
   "ds": "79thp",
   "code": 79,
   "awips": "N3P",
   "disabled": true,
   "unit": "in"
  },
  {
   "index": 31,
   "id": "l3.dod",
   "name": "DOD",
   "category": "Precipitation",
   "tilt": null,
   "ds": "174od",
   "code": 174,
   "awips": "DOD",
   "disabled": true,
   "unit": "in"
  },
  {
   "index": 32,
   "id": "l3.dsd",
   "name": "DSD",
   "category": "Precipitation",
   "tilt": null,
   "ds": "175sd",
   "code": 175,
   "awips": "DSD",
   "disabled": true,
   "unit": "in"
  },
  {
   "index": 33,
   "id": "l3.hca.0",
   "name": "0.5° Digital HCA",
   "category": "Hydrometeor Classification",
   "tilt": "0.5",
   "ds": "165h0",
   "code": 165,
   "awips": "N0H",
   "disabled": false,
   "unit": ""
  },
  {
   "index": 34,
   "id": "l3.hhc",
   "name": "Hybrid Scan HCA",
   "category": "Hydrometeor Classification",
   "tilt": null,
   "ds": "177hh",
   "code": 177,
   "awips": "HHC",
   "disabled": false,
   "unit": ""
  },
  {
   "index": 35,
   "id": "l3.hca.a",
   "name": "0.9° Digital HCA",
   "category": "Hydrometeor Classification",
   "tilt": "0.9",
   "ds": "165ha",
   "code": 165,
   "awips": "NAH",
   "disabled": false,
   "unit": ""
  },
  {
   "index": 36,
   "id": "l3.hca.1",
   "name": "~1.4° Digital HCA",
   "category": "Hydrometeor Classification",
   "tilt": "~1.4",
   "ds": "165h1",
   "code": 165,
   "awips": "N1H",
   "disabled": false,
   "unit": ""
  },
  {
   "index": 37,
   "id": "l3.hca.b",
   "name": "1.8° Digital HCA",
   "category": "Hydrometeor Classification",
   "tilt": "1.8",
   "ds": "165hb",
   "code": 165,
   "awips": "NBH",
   "disabled": false,
   "unit": ""
  },
  {
   "index": 38,
   "id": "l3.hca.2",
   "name": "~2.5° Digital HCA",
   "category": "Hydrometeor Classification",
   "tilt": "~2.5",
   "ds": "165h2",
   "code": 165,
   "awips": "N2H",
   "disabled": false,
   "unit": ""
  },
  {
   "index": 39,
   "id": "l3.hca.3",
   "name": "~3.4° Digital HCA",
   "category": "Hydrometeor Classification",
   "tilt": "~3.4",
   "ds": "165h3",
   "code": 165,
   "awips": "N3H",
   "disabled": false,
   "unit": ""
  },
  {
   "index": 40,
   "id": "l3.zdr.0",
   "name": "0.5° Digital Differential Refl.",
   "category": "Differential Reflectivity",
   "tilt": "0.5",
   "ds": "159x0",
   "code": 159,
   "awips": "N0X",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 41,
   "id": "l3.zdr.a",
   "name": "0.9° Digital Differential Refl.",
   "category": "Differential Reflectivity",
   "tilt": "0.9",
   "ds": "159xa",
   "code": 159,
   "awips": "NAX",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 42,
   "id": "l3.zdr.1",
   "name": "~1.4° Digital Differential Refl.",
   "category": "Differential Reflectivity",
   "tilt": "~1.4",
   "ds": "159x1",
   "code": 159,
   "awips": "N1X",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 43,
   "id": "l3.zdr.b",
   "name": "1.8° Digital Differential Refl.",
   "category": "Differential Reflectivity",
   "tilt": "1.8",
   "ds": "159xb",
   "code": 159,
   "awips": "NBX",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 44,
   "id": "l3.zdr.2",
   "name": "~2.5° Digital Differential Refl.",
   "category": "Differential Reflectivity",
   "tilt": "~2.5",
   "ds": "159x2",
   "code": 159,
   "awips": "N2X",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 45,
   "id": "l3.zdr.3",
   "name": "~3.4° Digital Differential Refl.",
   "category": "Differential Reflectivity",
   "tilt": "~3.4",
   "ds": "159x3",
   "code": 159,
   "awips": "N3X",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 46,
   "id": "l3.cc.0",
   "name": "0.5° Digital Correlation Coeff.",
   "category": "Correlation Coefficient",
   "tilt": "0.5",
   "ds": "161c0",
   "code": 161,
   "awips": "N0C",
   "disabled": false,
   "unit": "%"
  },
  {
   "index": 47,
   "id": "l3.cc.a",
   "name": "0.9° Digital Correlation Coeff.",
   "category": "Correlation Coefficient",
   "tilt": "0.9",
   "ds": "161ca",
   "code": 161,
   "awips": "NAC",
   "disabled": false,
   "unit": "%"
  },
  {
   "index": 48,
   "id": "l3.cc.1",
   "name": "~1.4° Digital Correlation Coeff.",
   "category": "Correlation Coefficient",
   "tilt": "~1.4",
   "ds": "161c1",
   "code": 161,
   "awips": "N1C",
   "disabled": false,
   "unit": "%"
  },
  {
   "index": 49,
   "id": "l3.cc.b",
   "name": "1.8° Digital Correlation Coeff.",
   "category": "Correlation Coefficient",
   "tilt": "1.8",
   "ds": "161cb",
   "code": 161,
   "awips": "NBC",
   "disabled": false,
   "unit": "%"
  },
  {
   "index": 50,
   "id": "l3.cc.2",
   "name": "~2.5° Digital Correlation Coeff.",
   "category": "Correlation Coefficient",
   "tilt": "~2.5",
   "ds": "161c2",
   "code": 161,
   "awips": "N2C",
   "disabled": false,
   "unit": "%"
  },
  {
   "index": 51,
   "id": "l3.cc.3",
   "name": "~3.4° Digital Correlation Coeff.",
   "category": "Correlation Coefficient",
   "tilt": "~3.4",
   "ds": "161c3",
   "code": 161,
   "awips": "N3C",
   "disabled": false,
   "unit": "%"
  },
  {
   "index": 52,
   "id": "l3.kdp.0",
   "name": "0.5° Digital KDP",
   "category": "Specific Differential Phase",
   "tilt": "0.5",
   "ds": "163k0",
   "code": 163,
   "awips": "N0K",
   "disabled": false,
   "unit": "°/km"
  },
  {
   "index": 53,
   "id": "l3.kdp.a",
   "name": "0.9° Digital KDP",
   "category": "Specific Differential Phase",
   "tilt": "0.9",
   "ds": "163ka",
   "code": 163,
   "awips": "NAK",
   "disabled": false,
   "unit": "°/km"
  },
  {
   "index": 54,
   "id": "l3.kdp.1",
   "name": "~1.4° Digital KDP",
   "category": "Specific Differential Phase",
   "tilt": "~1.4",
   "ds": "163k1",
   "code": 163,
   "awips": "N1K",
   "disabled": false,
   "unit": "°/km"
  },
  {
   "index": 55,
   "id": "l3.kdp.b",
   "name": "1.8° Digital KDP",
   "category": "Specific Differential Phase",
   "tilt": "1.8",
   "ds": "163kb",
   "code": 163,
   "awips": "NBK",
   "disabled": false,
   "unit": "°/km"
  },
  {
   "index": 56,
   "id": "l3.kdp.2",
   "name": "~2.5° Digital KDP",
   "category": "Specific Differential Phase",
   "tilt": "~2.5",
   "ds": "163k2",
   "code": 163,
   "awips": "N2K",
   "disabled": false,
   "unit": "°/km"
  },
  {
   "index": 57,
   "id": "l3.kdp.3",
   "name": "~3.4° Digital KDP",
   "category": "Specific Differential Phase",
   "tilt": "~3.4",
   "ds": "163k3",
   "code": 163,
   "awips": "N3K",
   "disabled": false,
   "unit": "°/km"
  },
  {
   "index": 58,
   "id": "l3.lcr.low",
   "name": "Layer Composite Refl. (AP Removed)",
   "category": "Reflectivity",
   "tilt": null,
   "ds": "67apr",
   "code": 67,
   "awips": "NLA",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 59,
   "id": "l3.lcr.mid",
   "name": "Layer Composite Refl. (Middle)",
   "category": "Reflectivity",
   "tilt": null,
   "ds": "66lrm",
   "code": 66,
   "awips": "NML",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 60,
   "id": "l3.lcr.high",
   "name": "Layer Composite Refl. (High)",
   "category": "Reflectivity",
   "tilt": null,
   "ds": "90lrm",
   "code": 90,
   "awips": "NHL",
   "disabled": false,
   "unit": "dBz"
  },
  {
   "index": 61,
   "id": "l3.dua.3h",
   "name": "User Accumulation (3-hour/hourly)",
   "category": "Precipitation",
   "tilt": null,
   "ds": "173u1",
   "code": 173,
   "awips": "DU3",
   "disabled": false,
   "unit": "in"
  },
  {
   "index": 62,
   "id": "l3.dua.24h",
   "name": "User Accumulation (24-hour/12Z)",
   "category": "Precipitation",
   "tilt": null,
   "ds": "173u3",
   "code": 173,
   "awips": "DU6",
   "disabled": false,
   "unit": "in"
  }
 ],
 "level3Overlays": [
  {
   "id": "l3.sti",
   "name": "Storm Tracking Information (cells/tracks)",
   "ds": "58sti",
   "code": 58,
   "ui": "Cells"
  },
  {
   "id": "l3.tvs",
   "name": "Tornado Vortex Signature",
   "ds": "61tvs",
   "code": 61,
   "ui": "TVS"
  },
  {
   "id": "l3.hi",
   "name": "Hail Index",
   "ds": "p59hi",
   "code": 59,
   "ui": "Hail"
  },
  {
   "id": "l3.md",
   "name": "Mesocyclone Detection",
   "ds": "141md",
   "code": 141,
   "ui": "MESO"
  },
  {
   "id": "l3.ss",
   "name": "Storm Structure",
   "ds": "p62ss",
   "code": 62,
   "ui": "(SCIT table input; inferred)"
  },
  {
   "id": "l3.ml",
   "name": "Melting Layer",
   "ds": "166m{0,a,1,b,2,3}",
   "code": 166,
   "ui": "ML (tilt chosen in ML popup: 0.5,0.9,1.3/1.5,1.8,2.4/2.5,3.1/3.4/3.5)"
  },
  {
   "id": "l3.gsm",
   "name": "General Status Message (VCP etc.)",
   "ds": "p2gsm",
   "code": 2,
   "ui": "status (inferred)"
  }
 ],
 "level2": [
  {
   "index": 0,
   "name": "Reflectivity",
   "kind": "base",
   "paletteKey": "NEXRAD/Level2ReflectivityPalette",
   "low": -31,
   "high": 225,
   "reserve": false,
   "unit": "dBz"
  },
  {
   "index": 1,
   "name": "Base Velocity",
   "kind": "base",
   "paletteKey": "NEXRAD/Level2BaseVelocityPalette",
   "low": -127,
   "high": 126,
   "reserve": true,
   "unit": "kts"
  },
  {
   "index": 2,
   "name": "Spectrum Width",
   "kind": "base",
   "paletteKey": "NEXRAD/Level2SpectrumWidthPalette",
   "low": -127,
   "high": 126,
   "reserve": true,
   "unit": "kts"
  },
  {
   "index": 3,
   "name": "ZDR",
   "kind": "base",
   "paletteKey": "NEXRAD/Level2ZDRPalette",
   "low": -7.875,
   "high": 7.9375,
   "reserve": true,
   "unit": "dbZ"
  },
  {
   "index": 4,
   "name": "PHI",
   "kind": "base",
   "paletteKey": "NEXRAD/Level2PHIPalette",
   "low": 0,
   "high": 360,
   "reserve": true,
   "unit": "°"
  },
  {
   "index": 5,
   "name": "CC",
   "kind": "base",
   "paletteKey": "NEXRAD/Level2CCPalette",
   "low": 20.83,
   "high": 105.16,
   "reserve": true,
   "unit": "%"
  },
  {
   "index": 6,
   "name": "Base Velocity (Dealiased)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2BaseVelocityPalette",
   "low": -127,
   "high": 126,
   "reserve": true,
   "unit": "kts"
  },
  {
   "index": 7,
   "name": "Storm-Relative Velocity (Dealiased)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2StormRelativeVelocityPalette",
   "low": -127,
   "high": 126,
   "reserve": true,
   "unit": "kts"
  },
  {
   "index": 8,
   "name": "Wind Shear (Azimuthal)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2ShearPalette",
   "low": -40,
   "high": 40,
   "reserve": false,
   "unit": "-"
  },
  {
   "index": 9,
   "name": "Gate-to-Gate Shear",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2G2GShearPalette",
   "low": -127,
   "high": 128,
   "reserve": false,
   "unit": "kts"
  },
  {
   "index": 10,
   "name": "KDP (Specific Differential Phase)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2KDPPalette",
   "low": -2,
   "high": 9,
   "reserve": false,
   "unit": "deg/km"
  },
  {
   "index": 11,
   "name": "MEHS (Mean Estimated Hail Size)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2MEHSPalette",
   "low": 0,
   "high": 7,
   "reserve": false,
   "unit": "in"
  },
  {
   "index": 12,
   "name": "POSH (Probability of Severe Hail)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2POSHPalette",
   "low": 0,
   "high": 100,
   "reserve": false,
   "unit": "%"
  },
  {
   "index": 13,
   "name": "VIL (Vertically Integrated Liquid)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2VILPalette",
   "low": 0,
   "high": 80,
   "reserve": false,
   "unit": "kg/m^2"
  },
  {
   "index": 14,
   "name": "VILD (VIL Density)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2VILDPalette",
   "low": 0,
   "high": 7,
   "reserve": false,
   "unit": "g/m^3"
  },
  {
   "index": 15,
   "name": "ET (Echo Tops)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2ETPalette",
   "low": 0,
   "high": 68.8976,
   "reserve": false,
   "unit": "kft"
  },
  {
   "index": 16,
   "name": "Downdraft Gust Potential",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2GUSTPalette",
   "low": 0,
   "high": 100,
   "reserve": false,
   "unit": "mph"
  },
  {
   "index": 17,
   "name": "ZDR Column (max ZDR above -10°C)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2ColumnZDRPalette",
   "low": -4.75,
   "high": 8,
   "reserve": false,
   "unit": "dB"
  },
  {
   "index": 18,
   "name": "KDP Column (max KDP above -10°C)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2ColumnKDPPalette",
   "low": -2,
   "high": 9,
   "reserve": false,
   "unit": "deg/km"
  },
  {
   "index": 19,
   "name": "Hail Core (max reflectivity above -20°C)",
   "kind": "derived",
   "paletteKey": "NEXRAD/Level2HailCorePalette",
   "low": -32,
   "high": 95.5,
   "reserve": false,
   "unit": "dBz"
  }
 ],
 "level3Categories": [
  "Reflectivity",
  "Velocity",
  "Spectrum Width",
  "Precipitation",
  "Hydrometeor Classification",
  "Differential Reflectivity",
  "Correlation Coefficient",
  "Specific Differential Phase"
 ],
 "basicLayers": [
  {
   "id": "basic.nr.base_qc",
   "label": "Base (QC)",
   "index": 0,
   "productKey": "bref2"
  },
  {
   "id": "basic.nr.seamless_hsr",
   "label": "Seamless HSR",
   "index": 2,
   "productKey": "hsr2"
  },
  {
   "id": "basic.nr.composite_qc",
   "label": "Composite (QC)",
   "index": 1,
   "productKey": "cref2"
  },
  {
   "id": "basic.nr.ptype",
   "label": "P-Typed",
   "index": null,
   "productKey": null
  },
  {
   "id": "basic.sat.*",
   "label": "Satellite Imagery (Off, RGB, Sandwich, Near-IR, WV Low/High, IR, VIS1, VIS2)",
   "index": null,
   "productKey": null
  },
  {
   "id": "basic.lightning",
   "label": "Lightning (GLM)",
   "index": null,
   "productKey": null
  },
  {
   "id": "basic.extended_goes",
   "label": "Extended GOES-R Data",
   "index": null,
   "productKey": null
  },
  {
   "id": "basic.warnings",
   "label": "TOR SVR SQW SMW FFW SWS EWW",
   "index": null,
   "productKey": null
  },
  {
   "id": "basic.watches",
   "label": "Severe Watches",
   "index": null,
   "productKey": null
  },
  {
   "id": "basic.sa.mslp",
   "label": "MSLP",
   "index": null,
   "productKey": null
  },
  {
   "id": "basic.sa.fronts_centers",
   "label": "Fronts / Centers",
   "index": null,
   "productKey": null
  },
  {
   "id": "basic.sa.wind10m",
   "label": "10m Wind",
   "index": null,
   "productKey": null
  },
  {
   "id": "basic.sa.fill",
   "label": "High-Res Fill: 2m Temp / 2m Dew Pt / Sfc. CAPE / MUCAPE / MLCAPE",
   "index": null,
   "productKey": null
  }
 ]
} as const;
