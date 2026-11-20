// Runtime catalog of the extra section products (MRMS, Meso, NDFD, WPC, CPC, SPC, LSR, tropical, model
// configuration names) and the section tab list. Maintained by hand.
export const XPRODUCTS = {
 "mrms": [
  {
   "index": 0,
   "label": "Base Reflectivity",
   "category": "Reflectivity",
   "categoryIndex": 0,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "dBz",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsReflectivityPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MergedBaseReflectivityQC_00.50/{YYYYMMDD}/MRMS_MergedBaseReflectivityQC_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MergedBaseReflectivityQC/",
   "prefix": "MRMS_MergedBaseReflectivityQC_00.50_"
  },
  {
   "index": 1,
   "label": "Composite Reflectivity",
   "category": "Reflectivity",
   "categoryIndex": 0,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "dBz",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsReflectivityPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MergedReflectivityQCComposite_00.50/{YYYYMMDD}/MRMS_MergedReflectivityQCComposite_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MergedReflectivityQCComposite/",
   "prefix": "MRMS_MergedReflectivityQCComposite_00.50_"
  },
  {
   "index": 2,
   "label": "Hybrid Scan Reflectivity",
   "category": "Reflectivity",
   "categoryIndex": 0,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "dBz",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsReflectivityPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/SeamlessHSR_00.00/{YYYYMMDD}/MRMS_SeamlessHSR_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/SeamlessHSR/",
   "prefix": "MRMS_SeamlessHSR_00.00_"
  },
  {
   "index": 3,
   "label": "1 Hour QPE",
   "category": "Precipitation Amount",
   "categoryIndex": 1,
   "refreshMin": 2,
   "flag2": 1,
   "unit": "in",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    3.93701
   ],
   "palette": "settings.mrms1HrPrecipPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RadarOnly_QPE_01H_00.00/{YYYYMMDD}/MRMS_RadarOnly_QPE_01H_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_01H/",
   "prefix": "MRMS_RadarOnly_QPE_01H_00.00_"
  },
  {
   "index": 4,
   "label": "Precipitation Rate",
   "category": "Precipitation Amount",
   "categoryIndex": 1,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "in/hr",
   "rawRange": [
    0,
    600
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    23.62206
   ],
   "palette": "settings.mrmsPrecipRatePalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/PrecipRate_00.00/{YYYYMMDD}/MRMS_PrecipRate_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/PrecipRate/",
   "prefix": "MRMS_PrecipRate_00.00_"
  },
  {
   "index": 5,
   "label": "3 Hour QPE",
   "category": "Precipitation Amount",
   "categoryIndex": 1,
   "refreshMin": 60,
   "flag2": 1,
   "unit": "in",
   "rawRange": [
    0,
    1000
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    39.3701
   ],
   "palette": "settings.mrms6HrPrecipPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RadarOnly_QPE_03H_00.00/{YYYYMMDD}/MRMS_RadarOnly_QPE_03H_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_03H/",
   "prefix": "MRMS_RadarOnly_QPE_03H_00.00_"
  },
  {
   "index": 6,
   "label": "6 Hour QPE",
   "category": "Precipitation Amount",
   "categoryIndex": 1,
   "refreshMin": 60,
   "flag2": 1,
   "unit": "in",
   "rawRange": [
    0,
    1500
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    59.05515
   ],
   "palette": "settings.mrms6HrPrecipPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RadarOnly_QPE_06H_00.00/{YYYYMMDD}/MRMS_RadarOnly_QPE_06H_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_06H/",
   "prefix": "MRMS_RadarOnly_QPE_06H_00.00_"
  },
  {
   "index": 7,
   "label": "12 Hour QPE",
   "category": "Precipitation Amount",
   "categoryIndex": 1,
   "refreshMin": 60,
   "flag2": 1,
   "unit": "in",
   "rawRange": [
    0,
    200
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    7.87402
   ],
   "palette": "settings.mrms24HrPrecipPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RadarOnly_QPE_12H_00.00/{YYYYMMDD}/MRMS_RadarOnly_QPE_12H_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_12H/",
   "prefix": "MRMS_RadarOnly_QPE_12H_00.00_"
  },
  {
   "index": 8,
   "label": "24 Hour QPE",
   "category": "Precipitation Amount",
   "categoryIndex": 1,
   "refreshMin": 60,
   "flag2": 1,
   "unit": "in",
   "rawRange": [
    0,
    4000
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    157.4804
   ],
   "palette": "settings.mrms24HrPrecipPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RadarOnly_QPE_24H_00.00/{YYYYMMDD}/MRMS_RadarOnly_QPE_24H_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_24H/",
   "prefix": "MRMS_RadarOnly_QPE_24H_00.00_"
  },
  {
   "index": 9,
   "label": "Hail Size (MEHS)",
   "category": "Hail",
   "categoryIndex": 2,
   "refreshMin": 2,
   "flag2": 1,
   "unit": "in",
   "rawRange": [
    0,
    40
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    1.574804
   ],
   "palette": "settings.mrmsMEHSPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MESH_00.50/{YYYYMMDD}/MRMS_MESH_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MESH/",
   "prefix": "MRMS_MESH_00.50_"
  },
  {
   "index": 10,
   "label": "Severe Hail Probability (POSH)",
   "category": "Hail",
   "categoryIndex": 2,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "%",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    3.93701
   ],
   "palette": "settings.mrmsPOSHPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/POSH_00.50/{YYYYMMDD}/MRMS_POSH_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/POSH/",
   "prefix": "MRMS_POSH_00.50_"
  },
  {
   "index": 11,
   "label": "MEHS Tracks 30 minutes",
   "category": "Hail",
   "categoryIndex": 2,
   "refreshMin": 2,
   "flag2": 1,
   "unit": "in",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsMEHSPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MESH_Max_30min_00.50/{YYYYMMDD}/MRMS_MESH_Max_30min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MESH_Max_30min/",
   "prefix": "MRMS_MESH_Max_30min_00.50_"
  },
  {
   "index": 12,
   "label": "MEHS Tracks 1 hour",
   "category": "Hail",
   "categoryIndex": 2,
   "refreshMin": 2,
   "flag2": 1,
   "unit": "in",
   "rawRange": [
    0,
    200
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    7.87402
   ],
   "palette": "settings.mrmsMEHSPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MESH_Max_60min_00.50/{YYYYMMDD}/MRMS_MESH_Max_60min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MESH_Max_60min/",
   "prefix": "MRMS_MESH_Max_60min_00.50_"
  },
  {
   "index": 13,
   "label": "MEHS Tracks 2 hours",
   "category": "Hail",
   "categoryIndex": 2,
   "refreshMin": 30,
   "flag2": 1,
   "unit": "in",
   "rawRange": [
    0,
    300
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    11.81103
   ],
   "palette": "settings.mrmsMEHSPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MESH_Max_120min_00.50/{YYYYMMDD}/MRMS_MESH_Max_120min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MESH_Max_120min/",
   "prefix": "MRMS_MESH_Max_120min_00.50_"
  },
  {
   "index": 14,
   "label": "MEHS Tracks 6 hours",
   "category": "Hail",
   "categoryIndex": 2,
   "refreshMin": 30,
   "flag2": 1,
   "unit": "in",
   "rawRange": [
    0,
    600
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    23.62206
   ],
   "palette": "settings.mrmsMEHSPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MESH_Max_360min_00.50/{YYYYMMDD}/MRMS_MESH_Max_360min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MESH_Max_360min/",
   "prefix": "MRMS_MESH_Max_360min_00.50_"
  },
  {
   "index": 15,
   "label": "MEHS Tracks 24 hours",
   "category": "Hail",
   "categoryIndex": 2,
   "refreshMin": 30,
   "flag2": 1,
   "unit": "in",
   "rawRange": [
    0,
    900
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    35.43309
   ],
   "palette": "settings.mrmsMEHSPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MESH_Max_1440min_00.50/{YYYYMMDD}/MRMS_MESH_Max_1440min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MESH_Max_1440min/",
   "prefix": "MRMS_MESH_Max_1440min_00.50_"
  },
  {
   "index": 16,
   "label": "Lightning Density 1min",
   "category": "Lightning",
   "categoryIndex": 3,
   "refreshMin": 1,
   "flag2": 1,
   "unit": "flashes/km²/min ",
   "rawRange": [
    0,
    20
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    0.787402
   ],
   "palette": "settings.mrmsLightningDensityPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/NLDN_CG_001min_AvgDensity_00.00/{YYYYMMDD}/MRMS_NLDN_CG_001min_AvgDensity_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/NLDN_CG_001min_AvgDensity/",
   "prefix": "MRMS_NLDN_CG_001min_AvgDensity_00.00_"
  },
  {
   "index": 17,
   "label": "Lightning Density 5min",
   "category": "Lightning",
   "categoryIndex": 3,
   "refreshMin": 1,
   "flag2": 1,
   "unit": "flashes/km²/min ",
   "rawRange": [
    0,
    20
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    20
   ],
   "palette": "settings.mrmsLightningDensityPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/NLDN_CG_005min_AvgDensity_00.00/{YYYYMMDD}/MRMS_NLDN_CG_005min_AvgDensity_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/NLDN_CG_005min_AvgDensity/",
   "prefix": "MRMS_NLDN_CG_005min_AvgDensity_00.00_"
  },
  {
   "index": 18,
   "label": "Lightning Density 15min",
   "category": "Lightning",
   "categoryIndex": 3,
   "refreshMin": 1,
   "flag2": 1,
   "unit": "flashes/km²/min ",
   "rawRange": [
    0,
    20
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    20
   ],
   "palette": "settings.mrmsLightningDensityPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/NLDN_CG_015min_AvgDensity_00.00/{YYYYMMDD}/MRMS_NLDN_CG_015min_AvgDensity_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/NLDN_CG_015min_AvgDensity/",
   "prefix": "MRMS_NLDN_CG_015min_AvgDensity_00.00_"
  },
  {
   "index": 19,
   "label": "Lightning Density 30min",
   "category": "Lightning",
   "categoryIndex": 3,
   "refreshMin": 1,
   "flag2": 1,
   "unit": "flashes/km²/min ",
   "rawRange": [
    0,
    20
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    20
   ],
   "palette": "settings.mrmsLightningDensityPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/NLDN_CG_030min_AvgDensity_00.00/{YYYYMMDD}/MRMS_NLDN_CG_030min_AvgDensity_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/NLDN_CG_030min_AvgDensity/",
   "prefix": "MRMS_NLDN_CG_030min_AvgDensity_00.00_"
  },
  {
   "index": 20,
   "label": "Next 30min Lighting Prob",
   "category": "Lightning",
   "categoryIndex": 3,
   "refreshMin": 15,
   "flag2": 0,
   "unit": "%",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsLightningProbPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/LightningProbabilityNext30minGrid_scale_1/{YYYYMMDD}/MRMS_LightningProbabilityNext30minGrid_scale_1_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/LightningProbabilityNext30min/",
   "prefix": "MRMS_LightningProbabilityNext30minGrid_scale_1_"
  },
  {
   "index": 21,
   "label": "Low-Level Shear (0-3km)",
   "category": "Shear/Rotation",
   "categoryIndex": 4,
   "refreshMin": 2,
   "flag2": 1,
   "unit": "0.001/s",
   "rawRange": [
    -100,
    127
   ],
   "multiplier": 1,
   "displayRange": [
    -100,
    127
   ],
   "palette": "settings.mrmsAzimuthalShearPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MergedAzShear_0-2kmAGL_00.50/{YYYYMMDD}/MRMS_MergedAzShear_0-2kmAGL_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MergedAzShear_0-2kmAGL/",
   "prefix": "MRMS_MergedAzShear_0-2kmAGL_00.50_"
  },
  {
   "index": 22,
   "label": "Mid-Level Shear (3-6km)",
   "category": "Shear/Rotation",
   "categoryIndex": 4,
   "refreshMin": 2,
   "flag2": 1,
   "unit": "0.001/s",
   "rawRange": [
    -100,
    127
   ],
   "multiplier": 1,
   "displayRange": [
    -100,
    127
   ],
   "palette": "settings.mrmsAzimuthalShearPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MergedAzShear_3-6kmAGL_00.50/{YYYYMMDD}/MRMS_MergedAzShear_3-6kmAGL_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MergedAzShear_3-6kmAGL/",
   "prefix": "MRMS_MergedAzShear_3-6kmAGL_00.50_"
  },
  {
   "index": 23,
   "label": "Rotation Tracks (LL) 30min",
   "category": "Shear/Rotation",
   "categoryIndex": 4,
   "refreshMin": 2,
   "flag2": 1,
   "unit": "0.001/s",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsROTTracksPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RotationTrack30min_00.50/{YYYYMMDD}/MRMS_RotationTrack30min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RotationTrack30min/",
   "prefix": "MRMS_RotationTrack30min_00.50_"
  },
  {
   "index": 24,
   "label": "Rotation Tracks (LL) 60min",
   "category": "Shear/Rotation",
   "categoryIndex": 4,
   "refreshMin": 2,
   "flag2": 1,
   "unit": "0.001/s",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsROTTracksPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RotationTrack60min_00.50/{YYYYMMDD}/MRMS_RotationTrack60min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RotationTrack60min/",
   "prefix": "MRMS_RotationTrack60min_00.50_"
  },
  {
   "index": 25,
   "label": "Rotation Tracks (LL) 120min",
   "category": "Shear/Rotation",
   "categoryIndex": 4,
   "refreshMin": 30,
   "flag2": 1,
   "unit": "0.001/s",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsROTTracksPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RotationTrack120min_00.50/{YYYYMMDD}/MRMS_RotationTrack120min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RotationTrack120min/",
   "prefix": "MRMS_RotationTrack120min_00.50_"
  },
  {
   "index": 26,
   "label": "Rotation Tracks (ML) 30min",
   "category": "Shear/Rotation",
   "categoryIndex": 4,
   "refreshMin": 2,
   "flag2": 1,
   "unit": "0.001/s",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsROTTracksPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RotationTrackML30min_00.50/{YYYYMMDD}/MRMS_RotationTrackML30min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RotationTrackML30min/",
   "prefix": "MRMS_RotationTrackML30min_00.50_"
  },
  {
   "index": 27,
   "label": "Rotation Tracks (ML) 60min",
   "category": "Shear/Rotation",
   "categoryIndex": 4,
   "refreshMin": 2,
   "flag2": 1,
   "unit": "0.001/s",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsROTTracksPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RotationTrackML60min_00.50/{YYYYMMDD}/MRMS_RotationTrackML60min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RotationTrackML60min/",
   "prefix": "MRMS_RotationTrackML60min_00.50_"
  },
  {
   "index": 28,
   "label": "Rotation Tracks (ML) 120min",
   "category": "Shear/Rotation",
   "categoryIndex": 4,
   "refreshMin": 30,
   "flag2": 1,
   "unit": "0.001/s",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsROTTracksPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RotationTrackML120min_00.50/{YYYYMMDD}/MRMS_RotationTrackML120min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RotationTrackML120min/",
   "prefix": "MRMS_RotationTrackML120min_00.50_"
  },
  {
   "index": 29,
   "label": "Echo Tops",
   "category": "Convective",
   "categoryIndex": 5,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "kft",
   "rawRange": [
    0,
    45
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    45
   ],
   "palette": "settings.mrmsETPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/EchoTop_18_00.50/{YYYYMMDD}/MRMS_EchoTop_18_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/EchoTop_18/",
   "prefix": "MRMS_EchoTop_18_00.50_"
  },
  {
   "index": 30,
   "label": "VIL",
   "category": "Convective",
   "categoryIndex": 5,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "kg/m²",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 3.28084,
   "displayRange": [
    0,
    328.084
   ],
   "palette": "settings.mrmsVILPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/VIL_00.50/{YYYYMMDD}/MRMS_VIL_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/VIL/",
   "prefix": "MRMS_VIL_00.50_"
  },
  {
   "index": 31,
   "label": "VILD",
   "category": "Convective",
   "categoryIndex": 5,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "g/m³",
   "rawRange": [
    0,
    20
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    20
   ],
   "palette": "settings.mrmsVILDPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/VIL_Density_00.50/{YYYYMMDD}/MRMS_VIL_Density_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/VIL_Density/",
   "prefix": "MRMS_VIL_Density_00.50_"
  },
  {
   "index": 32,
   "label": "Reflectivity at -10°C",
   "category": "Reflectivity",
   "categoryIndex": 0,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "dBz",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsReflectivityPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/Reflectivity_-10C_00.50/{YYYYMMDD}/MRMS_Reflectivity_-10C_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/Reflectivity_-10C/",
   "prefix": "MRMS_Reflectivity_-10C_00.50_"
  },
  {
   "index": 33,
   "label": "Reflectivity at -20°C",
   "category": "Reflectivity",
   "categoryIndex": 0,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "dBz",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsReflectivityPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/Reflectivity_-20C_00.50/{YYYYMMDD}/MRMS_Reflectivity_-20C_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/Reflectivity_-20C/",
   "prefix": "MRMS_Reflectivity_-20C_00.50_"
  },
  {
   "index": 34,
   "label": "H50 Above 0°C",
   "category": "Hail",
   "categoryIndex": 2,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "kft",
   "rawRange": [
    0,
    12
   ],
   "multiplier": 3.28084,
   "displayRange": [
    0,
    39.37008
   ],
   "palette": "ext.settings.mrmsHailDepthPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/H50_Above_0C_00.50/{YYYYMMDD}/MRMS_H50_Above_0C_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/H50_Above_0C/",
   "prefix": "MRMS_H50_Above_0C_00.50_"
  },
  {
   "index": 35,
   "label": "H50 Above -20°C",
   "category": "Hail",
   "categoryIndex": 2,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "kft",
   "rawRange": [
    0,
    12
   ],
   "multiplier": 3.28084,
   "displayRange": [
    0,
    39.37008
   ],
   "palette": "ext.settings.mrmsHailDepthPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/H50_Above_-20C_00.50/{YYYYMMDD}/MRMS_H50_Above_-20C_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/H50_Above_-20C/",
   "prefix": "MRMS_H50_Above_-20C_00.50_"
  },
  {
   "index": 36,
   "label": "H60 Above 0°C",
   "category": "Hail",
   "categoryIndex": 2,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "kft",
   "rawRange": [
    0,
    12
   ],
   "multiplier": 3.28084,
   "displayRange": [
    0,
    39.37008
   ],
   "palette": "ext.settings.mrmsHailDepthPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/H60_Above_0C_00.50/{YYYYMMDD}/MRMS_H60_Above_0C_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/H60_Above_0C/",
   "prefix": "MRMS_H60_Above_0C_00.50_"
  },
  {
   "index": 37,
   "label": "H60 Above -20°C",
   "category": "Hail",
   "categoryIndex": 2,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "kft",
   "rawRange": [
    0,
    12
   ],
   "multiplier": 3.28084,
   "displayRange": [
    0,
    39.37008
   ],
   "palette": "ext.settings.mrmsHailDepthPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/H60_Above_-20C_00.50/{YYYYMMDD}/MRMS_H60_Above_-20C_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/H60_Above_-20C/",
   "prefix": "MRMS_H60_Above_-20C_00.50_"
  },
  {
   "index": 38,
   "label": "Echo Tops 50 dBZ",
   "category": "Convective",
   "categoryIndex": 5,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "kft",
   "rawRange": [
    0,
    20
   ],
   "multiplier": 3.28084,
   "displayRange": [
    0,
    65.6168
   ],
   "palette": "settings.mrmsETPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/EchoTop_50_00.50/{YYYYMMDD}/MRMS_EchoTop_50_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/EchoTop_50/",
   "prefix": "MRMS_EchoTop_50_00.50_"
  },
  {
   "index": 39,
   "label": "Echo Tops 60 dBZ",
   "category": "Convective",
   "categoryIndex": 5,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "kft",
   "rawRange": [
    0,
    20
   ],
   "multiplier": 3.28084,
   "displayRange": [
    0,
    65.6168
   ],
   "palette": "settings.mrmsETPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/EchoTop_60_00.50/{YYYYMMDD}/MRMS_EchoTop_60_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/EchoTop_60/",
   "prefix": "MRMS_EchoTop_60_00.50_"
  },
  {
   "index": 40,
   "label": "48 Hour QPE (Multi-Sensor)",
   "category": "Precipitation Amount",
   "categoryIndex": 1,
   "refreshMin": 60,
   "flag2": 0,
   "unit": "in",
   "rawRange": [
    0,
    508
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    20.000011
   ],
   "palette": "settings.mrms24HrPrecipPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MultiSensor_QPE_48H_Pass2_00.00/{YYYYMMDD}/MRMS_MultiSensor_QPE_48H_Pass2_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MultiSensor_QPE_48H_Pass2/",
   "prefix": "MRMS_MultiSensor_QPE_48H_Pass2_00.00_"
  },
  {
   "index": 41,
   "label": "72 Hour QPE (Multi-Sensor)",
   "category": "Precipitation Amount",
   "categoryIndex": 1,
   "refreshMin": 60,
   "flag2": 0,
   "unit": "in",
   "rawRange": [
    0,
    508
   ],
   "multiplier": 0.0393701,
   "displayRange": [
    0,
    20.000011
   ],
   "palette": "settings.mrms24HrPrecipPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MultiSensor_QPE_72H_Pass2_00.00/{YYYYMMDD}/MRMS_MultiSensor_QPE_72H_Pass2_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/MultiSensor_QPE_72H_Pass2/",
   "prefix": "MRMS_MultiSensor_QPE_72H_Pass2_00.00_"
  },
  {
   "index": 42,
   "label": "Next 60min Lightning Prob",
   "category": "Lightning",
   "categoryIndex": 3,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "%",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsLightningProbPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/LightningProbabilityNext60minGrid_scale_1/{YYYYMMDD}/MRMS_LightningProbabilityNext60minGrid_scale_1_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/LightningProbabilityNext60min/",
   "prefix": "MRMS_LightningProbabilityNext60minGrid_scale_1_"
  },
  {
   "index": 43,
   "label": "Rotation Tracks (LL) 24hr",
   "category": "Shear/Rotation",
   "categoryIndex": 4,
   "refreshMin": 30,
   "flag2": 0,
   "unit": "0.001/s",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsROTTracksPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RotationTrack1440min_00.50/{YYYYMMDD}/MRMS_RotationTrack1440min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RotationTrack1440min/",
   "prefix": "MRMS_RotationTrack1440min_00.50_"
  },
  {
   "index": 44,
   "label": "Rotation Tracks (ML) 24hr",
   "category": "Shear/Rotation",
   "categoryIndex": 4,
   "refreshMin": 30,
   "flag2": 0,
   "unit": "0.001/s",
   "rawRange": [
    0,
    100
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    100
   ],
   "palette": "settings.mrmsROTTracksPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/RotationTrackML1440min_00.50/{YYYYMMDD}/MRMS_RotationTrackML1440min_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/RotationTrackML1440min/",
   "prefix": "MRMS_RotationTrackML1440min_00.50_"
  },
  {
   "index": 45,
   "label": "CREST Max Unit Streamflow",
   "category": "Flash Flood (FLASH)",
   "categoryIndex": 6,
   "refreshMin": 10,
   "flag2": 0,
   "unit": "m³/s/km²",
   "rawRange": [
    0,
    30
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    30
   ],
   "palette": "ext.settings.mrmsFlashStreamflowPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/FLASH_CREST_MAXUNITSTREAMFLOW_00.00/{YYYYMMDD}/MRMS_FLASH_CREST_MAXUNITSTREAMFLOW_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/FLASH/CREST_MAXUNITSTREAMFLOW/",
   "prefix": "MRMS_FLASH_CREST_MAXUNITSTREAMFLOW_00.00_"
  },
  {
   "index": 46,
   "label": "QPE-to-FFG Ratio (max 1/3/6 hr)",
   "category": "Flash Flood (FLASH)",
   "categoryIndex": 6,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "%",
   "rawRange": [
    0,
    250
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    250
   ],
   "palette": "ext.settings.mrmsFlashFFGRatioPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/FLASH_QPE_FFGMAX_00.00/{YYYYMMDD}/MRMS_FLASH_QPE_FFGMAX_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/FLASH/QPE_FFGMAX/",
   "prefix": "MRMS_FLASH_QPE_FFGMAX_00.00_"
  },
  {
   "index": 47,
   "label": "QPE Recurrence Interval (max)",
   "category": "Flash Flood (FLASH)",
   "categoryIndex": 6,
   "refreshMin": 2,
   "flag2": 0,
   "unit": "yr",
   "rawRange": [
    0,
    200
   ],
   "multiplier": 1,
   "displayRange": [
    0,
    200
   ],
   "palette": "ext.settings.mrmsFlashARIPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/FLASH_QPE_ARIMAX_00.00/{YYYYMMDD}/MRMS_FLASH_QPE_ARIMAX_00.00_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/FLASH/QPE_ARIMAX/",
   "prefix": "MRMS_FLASH_QPE_ARIMAX_00.00_"
  },
  {
   "index": 48,
   "label": "Freezing Level (0°C Height MSL)",
   "category": "Environment (Model)",
   "categoryIndex": 7,
   "refreshMin": 60,
   "flag2": 0,
   "unit": "ft",
   "rawRange": [
    0,
    5500
   ],
   "multiplier": 3.28084,
   "displayRange": [
    0,
    18044.62
   ],
   "palette": "ext.settings.mrmsFreezingLevelPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/Model_0degC_Height_00.50/{YYYYMMDD}/MRMS_Model_0degC_Height_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/Model_0degC_Height/",
   "prefix": "MRMS_Model_0degC_Height_00.50_"
  },
  {
   "index": 49,
   "label": "Surface Wet-Bulb Temperature",
   "category": "Environment (Model)",
   "categoryIndex": 7,
   "refreshMin": 60,
   "flag2": 0,
   "unit": "°C",
   "rawRange": [
    -30,
    30
   ],
   "multiplier": 1,
   "displayRange": [
    -30,
    30
   ],
   "palette": "ext.settings.mrmsWetBulbPalette",
   "s3": "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/Model_WetBulbTemp_00.50/{YYYYMMDD}/MRMS_Model_WetBulbTemp_00.50_{YYYYMMDD}-{HHMMSS}.grib2.gz",
   "ncep": "https://mrms.ncep.noaa.gov/2D/Model_WetBulbTemp/",
   "prefix": "MRMS_Model_WetBulbTemp_00.50_"
  }
 ],
 "mrmsCategories": [
  "Reflectivity",
  "Precipitation Amount",
  "Hail",
  "Lightning",
  "Shear/Rotation",
  "Convective",
  "Flash Flood (FLASH)",
  "Environment (Model)"
 ],
 "meso": [
  {
   "index": 0,
   "label": "Wind Gust",
   "match": [
    "GUST:surface"
   ],
   "unit": "mph",
   "range": [
    0,
    200
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 0
   },
   "derivation": "direct field"
  },
  {
   "index": 1,
   "label": "Surface Visibility",
   "match": [
    "VIS:surface"
   ],
   "unit": "miles",
   "range": [
    0,
    100
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 1
   },
   "derivation": "direct field"
  },
  {
   "index": 2,
   "label": "Surface CAPE",
   "match": [
    "CAPE:surface"
   ],
   "unit": "J/kg",
   "range": [
    0,
    6000
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 2
   },
   "derivation": "direct field"
  },
  {
   "index": 3,
   "label": "Surface CINH",
   "match": [
    "CIN:surface"
   ],
   "unit": "J/kg",
   "range": [
    -2500,
    100
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 3
   },
   "derivation": "direct field"
  },
  {
   "index": 4,
   "label": "90mb-0 CAPE",
   "match": [
    "CAPE:90-0 mb above ground"
   ],
   "unit": "J/kg",
   "range": [
    0,
    10000
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 4
   },
   "derivation": "direct field"
  },
  {
   "index": 5,
   "label": "90mb-0 CINH",
   "match": [
    "CIN:90-0 mb above ground"
   ],
   "unit": "J/kg",
   "range": [
    -2500,
    100
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 5
   },
   "derivation": "direct field"
  },
  {
   "index": 6,
   "label": "3-0km SRH",
   "match": [
    "HLCY:3000-0 m above ground"
   ],
   "unit": "m²/s²",
   "range": [
    -1000,
    3000
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 6
   },
   "derivation": "direct field"
  },
  {
   "index": 7,
   "label": "500-1000mb SLI",
   "match": [
    "LFTX:500-1000 mb"
   ],
   "unit": "K",
   "range": [
    -20,
    50
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 7
   },
   "derivation": "direct field"
  },
  {
   "index": 8,
   "label": "Echo Top Height",
   "match": [
    "RETOP:entire atmosphere"
   ],
   "unit": "m",
   "range": [
    0,
    50000
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 8
   },
   "derivation": "direct field"
  },
  {
   "index": 9,
   "label": "850mb Height",
   "match": [
    "HGT:850 mb"
   ],
   "unit": "m",
   "range": [
    300,
    2500
   ],
   "render": "contour",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 9
   },
   "derivation": "direct field"
  },
  {
   "index": 10,
   "label": "850mb Wind",
   "match": [
    "VGRD:850 mb",
    "UGRD:850 mb"
   ],
   "unit": "mph",
   "range": [
    0,
    300
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 10
   },
   "derivation": "speed = sqrt(u^2+v^2) * 2.23693629 (m/s -> mph)"
  },
  {
   "index": 11,
   "label": "850mb Temp",
   "match": [
    "TMP:850 mb"
   ],
   "unit": "F",
   "range": [
    -150,
    100
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 11
   },
   "derivation": "direct field"
  },
  {
   "index": 12,
   "label": "850mb Rel. Hum.",
   "match": [
    "RH:850 mb"
   ],
   "unit": "%",
   "range": [
    0,
    100
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 12
   },
   "derivation": "direct field"
  },
  {
   "index": 13,
   "label": "850mb Vert. Vel.",
   "match": [
    "VVEL:850 mb"
   ],
   "unit": "Pa/s",
   "range": [
    -20,
    20
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 13
   },
   "derivation": "direct field"
  },
  {
   "index": 14,
   "label": "700mb Height",
   "match": [
    "HGT:700 mb"
   ],
   "unit": "m",
   "range": [
    1400,
    4200
   ],
   "render": "contour",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 14
   },
   "derivation": "direct field"
  },
  {
   "index": 15,
   "label": "700mb Wind",
   "match": [
    "VGRD:700 mb",
    "UGRD:700 mb"
   ],
   "unit": "mph",
   "range": [
    0,
    350
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 15
   },
   "derivation": "speed = sqrt(u^2+v^2) * 2.23693629 (m/s -> mph)"
  },
  {
   "index": 16,
   "label": "700mb Temp",
   "match": [
    "TMP:700 mb"
   ],
   "unit": "F",
   "range": [
    -150,
    100
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 16
   },
   "derivation": "direct field"
  },
  {
   "index": 17,
   "label": "700mb Vert. Vel.",
   "match": [
    "VVEL:700 mb"
   ],
   "unit": "Pa/s",
   "range": [
    -15,
    15
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 17
   },
   "derivation": "direct field"
  },
  {
   "index": 18,
   "label": "500mb Height",
   "match": [
    "HGT:500 mb"
   ],
   "unit": "m",
   "range": [
    4000,
    7000
   ],
   "render": "contour",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 18
   },
   "derivation": "direct field"
  },
  {
   "index": 19,
   "label": "500mb Wind",
   "match": [
    "VGRD:500 mb",
    "UGRD:500 mb"
   ],
   "unit": "mph",
   "range": [
    0,
    350
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 19
   },
   "derivation": "speed = sqrt(u^2+v^2) * 2.23693629 (m/s -> mph)"
  },
  {
   "index": 20,
   "label": "500mb ABSV",
   "match": [
    "ABSV:500 mb"
   ],
   "unit": "1/s",
   "range": [
    -0.006000000052154064,
    0.006000000052154064
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 20
   },
   "derivation": "direct field"
  },
  {
   "index": 21,
   "label": "EHI",
   "match": [
    "CAPE:90-0 mb above ground",
    "HLCY:3000-0 m above ground"
   ],
   "unit": "EHI",
   "range": [
    -10,
    10
   ],
   "render": "fill",
   "palette": {
    "id": "settings.mesoanalysisPalettes",
    "index": 21
   },
   "derivation": "EHI = CAPE(90-0 mb) * SRH(3000-0 m) / 160000"
  }
 ],
 "severe": [
  {
   "id": "sevparam.stp",
   "label": "STP",
   "palette": "settings.stpPalette",
   "inputs": [
    "CAPE:surface",
    "HLCY:1000-0 m above",
    "VVCSH:0-6000 m",
    "DPT:2 m",
    "TMP:2 m",
    "PRES:surface"
   ],
   "range": [
    0,
    10
   ]
  },
  {
   "id": "sevparam.scp",
   "label": "SCP",
   "palette": "settings.scpPalette",
   "inputs": [
    "CAPE:surface",
    "HLCY:3000-0 m",
    "VVCSH:0-6000 m"
   ],
   "range": [
    0,
    50
   ]
  }
 ],
 "ndfd": {
  "regions": [
   "neast",
   "midatlan",
   "seast",
   "crgrlake",
   "ergrlake",
   "umissvly",
   "crmissvy",
   "smissvly",
   "nplains",
   "crplains",
   "splains",
   "nrockies",
   "srockies",
   "pacnwest",
   "pacswest",
   "puertori",
   "hawaii",
   "guam",
   "alaska"
  ],
  "listA": [
   {
    "index": 0,
    "caption": ">34kt Prob Tropical Sfc Wind inc.",
    "file": "ds.tcwspdabv34i.bin",
    "hours": [
     6,
     12,
     18,
     24,
     30,
     36,
     42,
     48,
     54,
     60
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 0
    }
   },
   {
    "index": 1,
    "caption": ">34kt Prob Tropical Sfc Wind cum.",
    "file": "ds.tcwspdabv34c.bin",
    "hours": [
     6,
     12,
     18,
     24,
     30,
     36,
     42,
     48,
     54,
     60
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 1
    }
   },
   {
    "index": 2,
    "caption": ">50kt Prob Tropical Sfc Wind inc.",
    "file": "ds.tcwspdabv50i.bin",
    "hours": [
     6,
     12,
     18,
     24,
     30,
     36,
     42,
     48,
     54,
     60
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 2
    }
   },
   {
    "index": 3,
    "caption": ">50kt Prob Tropical Sfc Wind cum.",
    "file": "ds.tcwspdabv50c.bin",
    "hours": [
     6,
     12,
     18,
     24,
     30,
     36,
     42,
     48,
     54,
     60
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 3
    }
   },
   {
    "index": 4,
    "caption": ">64kt Prob Tropical Sfc Wind inc.",
    "file": "ds.tcwspdabv64i.bin",
    "hours": [
     6,
     12,
     18,
     24,
     30,
     36,
     42,
     48,
     54,
     60
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 4
    }
   },
   {
    "index": 5,
    "caption": ">64kt Prob Tropical Sfc Wind cum.",
    "file": "ds.tcwspdabv64c.bin",
    "hours": [
     6,
     12,
     18,
     24,
     30,
     36,
     42,
     48,
     54,
     60
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 5
    }
   },
   {
    "index": 6,
    "caption": "Sky Cover",
    "file": "ds.sky.bin",
    "hours": [
     0,
     3,
     6,
     9,
     12,
     15,
     18,
     21,
     24,
     27,
     30,
     33,
     36,
     39,
     42,
     45,
     48,
     51,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 6
    }
   },
   {
    "index": 7,
    "caption": "Wind Direction",
    "file": "ds.wdir.bin",
    "hours": [
     0,
     3,
     6,
     9,
     12,
     15,
     18,
     21,
     24,
     27,
     30,
     33,
     36,
     39,
     42,
     45,
     48,
     51,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 7
    }
   },
   {
    "index": 8,
    "caption": "Wind Speed",
    "file": "ds.wspd.bin",
    "hours": [
     0,
     3,
     6,
     9,
     12,
     15,
     18,
     21,
     24,
     27,
     30,
     33,
     36,
     39,
     42,
     45,
     48,
     51,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 8
    }
   },
   {
    "index": 9,
    "caption": "12-hr Precip Prob",
    "file": "ds.pop12.bin",
    "hours": [
     6,
     18,
     30,
     42,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 9
    }
   },
   {
    "index": 10,
    "caption": "Temperature",
    "file": "ds.temp.bin",
    "hours": [
     0,
     3,
     6,
     9,
     12,
     15,
     18,
     21,
     24,
     27,
     30,
     33,
     36,
     39,
     42,
     45,
     48,
     51,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 10
    }
   },
   {
    "index": 11,
    "caption": "Dewpoint",
    "file": "ds.td.bin",
    "hours": [
     0,
     3,
     6,
     9,
     12,
     15,
     18,
     21,
     24,
     27,
     30,
     33,
     36,
     39,
     42,
     45,
     48,
     51,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 11
    }
   },
   {
    "index": 12,
    "caption": "Maximum Temperature",
    "file": "ds.maxt.bin",
    "hours": [
     -1,
     -2,
     -3
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 12
    }
   },
   {
    "index": 13,
    "caption": "Minimum Temperature",
    "file": "ds.mint.bin",
    "hours": [
     -1,
     -2
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 13
    }
   },
   {
    "index": 14,
    "caption": "Quantitative Precipitation Forecast",
    "file": "ds.qpf.bin",
    "hours": [
     1,
     6,
     12,
     18,
     24,
     30,
     36,
     42,
     48,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 14
    }
   },
   {
    "index": 15,
    "caption": "Weather",
    "file": "ds.wx.bin",
    "hours": [
     0,
     3,
     6,
     9,
     12,
     15,
     18,
     21,
     24,
     27,
     30,
     33,
     36,
     39,
     42,
     45,
     48,
     51,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 15
    }
   },
   {
    "index": 16,
    "caption": "Significant Wave Height",
    "file": "ds.waveh.bin",
    "hours": [
     1,
     6,
     12,
     18,
     24,
     30,
     36,
     42,
     48,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 16
    }
   },
   {
    "index": 17,
    "caption": "Relative Humidity",
    "file": "ds.rhm.bin",
    "hours": [
     0,
     3,
     6,
     9,
     12,
     15,
     18,
     21,
     24,
     27,
     30,
     33,
     36,
     39,
     42,
     45,
     48,
     51,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 17
    }
   },
   {
    "index": 18,
    "caption": "Snow Amount",
    "file": "ds.snow.bin",
    "hours": [
     0,
     6,
     12,
     18,
     24,
     30
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 18
    }
   },
   {
    "index": 19,
    "caption": "Apparent Temperature",
    "file": "ds.apt.bin",
    "hours": [
     0,
     3,
     6,
     9,
     12,
     15,
     18,
     21,
     24,
     27,
     30,
     33,
     36,
     39,
     42,
     45,
     48,
     51,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 19
    }
   },
   {
    "index": 20,
    "caption": "Wind Gust Speed",
    "file": "ds.wgust.bin",
    "hours": [
     0,
     3,
     6,
     9,
     12,
     15,
     18,
     21,
     24,
     27,
     30,
     33,
     36,
     39,
     42,
     45,
     48,
     51,
     54
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 20
    }
   },
   {
    "index": 21,
    "caption": "Hazards",
    "file": "ds.wwa.bin",
    "hours": [
     0,
     1,
     2,
     3,
     4,
     5,
     6,
     7,
     8,
     9,
     10,
     11,
     12,
     13,
     14,
     15,
     16,
     17,
     18,
     19,
     20,
     21,
     22,
     23,
     24,
     25,
     26,
     27,
     28,
     29,
     30,
     31,
     32,
     33,
     34,
     35,
     36,
     37,
     38,
     39
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 21
    }
   },
   {
    "index": 22,
    "caption": "Prob of Tornadoes",
    "file": "ds.ptornado.bin",
    "hours": [
     -1
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 22
    }
   },
   {
    "index": 23,
    "caption": "Prob of Hail",
    "file": "ds.phail.bin",
    "hours": [
     -1
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 23
    }
   },
   {
    "index": 24,
    "caption": "Prob of Damaging Thunderstorm Winds",
    "file": "ds.ptstmwinds.bin",
    "hours": [
     -1
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 24
    }
   },
   {
    "index": 25,
    "caption": "Prob of Extreme Tornadoes",
    "file": "ds.pxtornado.bin",
    "hours": [
     -1
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 25
    }
   },
   {
    "index": 26,
    "caption": "Prob of Extreme Hail",
    "file": "ds.pxhail.bin",
    "hours": [
     -1
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 26
    }
   },
   {
    "index": 27,
    "caption": "Prob of Extreme Thunderstorm Winds",
    "file": "ds.pxtstmwinds.bin",
    "hours": [
     -1
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 27
    }
   },
   {
    "index": 28,
    "caption": "Total Prob of Severe Thunderstorms",
    "file": "ds.ptotsvrtstm.bin",
    "hours": [
     52,
     76
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 28
    }
   },
   {
    "index": 29,
    "caption": "Total Prob of Extreme Svr Thunderstorms",
    "file": "ds.ptotxsvrtstm.bin",
    "hours": [
     52,
     76
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 29
    }
   },
   {
    "index": 30,
    "caption": "Convective Hazard Outlook",
    "file": "ds.conhazo.bin",
    "hours": [
     -1,
     -2,
     -3
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 30
    }
   },
   {
    "index": 31,
    "caption": "Critical/Extreme-Critical Risk Fire Outlook",
    "file": "ds.critfireo.bin",
    "hours": [
     -1,
     -2,
     -3
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 31
    }
   },
   {
    "index": 32,
    "caption": "Dry Lightning T-Storm Risk Fire Outlook",
    "file": "ds.dryfireo.bin",
    "hours": [
     -1,
     -2
    ],
    "palette": {
     "id": "settings.ndfdPalettes",
     "index": 32
    }
   }
  ],
  "listB": [
   {
    "index": 0,
    "caption": "Apparent Temperature",
    "file": "ds.apt.bin"
   },
   {
    "index": 1,
    "caption": "Maximum Relative Humidity",
    "file": "ds.maxrh.bin"
   },
   {
    "index": 2,
    "caption": "Maximum Temperature",
    "file": "ds.maxt.bin"
   },
   {
    "index": 3,
    "caption": "Minimum Relative Humidity",
    "file": "ds.minrh.bin"
   },
   {
    "index": 4,
    "caption": "Minimum Temperature",
    "file": "ds.mint.bin"
   },
   {
    "index": 5,
    "caption": "12-hr Precip Prob",
    "file": "ds.pop12.bin"
   },
   {
    "index": 6,
    "caption": "Quantitative Precipitation Forecast",
    "file": "ds.qpf.bin"
   },
   {
    "index": 7,
    "caption": "Relative Humidity",
    "file": "ds.rhm.bin"
   },
   {
    "index": 8,
    "caption": "Sky Cover",
    "file": "ds.sky.bin"
   },
   {
    "index": 9,
    "caption": "Snow Amount",
    "file": "ds.snow.bin"
   },
   {
    "index": 10,
    "caption": "Dew-point",
    "file": "ds.td.bin"
   },
   {
    "index": 11,
    "caption": "Temperature",
    "file": "ds.temp.bin"
   },
   {
    "index": 12,
    "caption": "Wave Height",
    "file": "ds.waveh.bin"
   },
   {
    "index": 13,
    "caption": "Wind Direction",
    "file": "ds.wdir.bin"
   },
   {
    "index": 14,
    "caption": "Wind Gust Speed",
    "file": "ds.wgust.bin"
   },
   {
    "index": 15,
    "caption": "Wind Speed",
    "file": "ds.wspd.bin"
   },
   {
    "index": 16,
    "caption": "Hazards",
    "file": "ds.wwa.bin"
   },
   {
    "index": 17,
    "caption": "Weather",
    "file": "ds.wx.bin"
   }
  ]
 },
 "wpcQpf": [
  {
   "index": 0,
   "label": "24hr / Day 1",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/day1/QPF24hr_Day1_latest.tar"
  },
  {
   "index": 1,
   "label": "24hr / Day 2",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/day2/QPF24hr_Day2_latest.tar"
  },
  {
   "index": 2,
   "label": "24hr / Day 3",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/day3/QPF24hr_Day3_latest.tar"
  },
  {
   "index": 3,
   "label": "48hr / Day 1-2",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/day12/QPF48hr_Day1-2_latest.tar"
  },
  {
   "index": 4,
   "label": "48hr / Day 4-5",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/day45/QPF48hr_Day4-5_latest.tar"
  },
  {
   "index": 5,
   "label": "72hr / Day 1-3",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/day13/QPF72hr_Day1-3_latest.tar"
  },
  {
   "index": 6,
   "label": "120hr / Day 1-5",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/5day/QPF120hr_Day1-5_latest.tar"
  }
 ],
 "wpcEro": [
  {
   "index": 0,
   "label": "Day 1",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/excessive/EXCESSIVERAIN_Day1_latest.zip",
   "styles": [
    "EROMRGL",
    "EROSLGT",
    "EROMDT",
    "EROHIGH"
   ]
  },
  {
   "index": 1,
   "label": "Day 2",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/excessive/EXCESSIVERAIN_Day2_latest.zip",
   "styles": [
    "EROMRGL",
    "EROSLGT",
    "EROMDT",
    "EROHIGH"
   ]
  },
  {
   "index": 2,
   "label": "Day 3",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/excessive/EXCESSIVERAIN_Day3_latest.zip",
   "styles": [
    "EROMRGL",
    "EROSLGT",
    "EROMDT",
    "EROHIGH"
   ]
  },
  {
   "index": 3,
   "label": "Day 4",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/excessive/EXCESSIVERAIN_Day4_latest.zip",
   "styles": [
    "EROMRGL",
    "EROSLGT",
    "EROMDT",
    "EROHIGH"
   ]
  },
  {
   "index": 4,
   "label": "Day 5",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/qpf/excessive/EXCESSIVERAIN_Day5_latest.zip",
   "styles": [
    "EROMRGL",
    "EROSLGT",
    "EROMDT",
    "EROHIGH"
   ]
  }
 ],
 "wpcWinter": [
  {
   "day": 1,
   "product": "PSNOW_GT_04",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day1/DAY1_PSNOW_GT_04_latest.tar"
  },
  {
   "day": 1,
   "product": "PSNOW_GT_08",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day1/DAY1_PSNOW_GT_08_latest.tar"
  },
  {
   "day": 1,
   "product": "PSNOW_GT_12",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day1/DAY1_PSNOW_GT_12_latest.tar"
  },
  {
   "day": 1,
   "product": "PICEZ_GT_25",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day1/DAY1_PICEZ_GT_25_latest.tar"
  },
  {
   "day": 2,
   "product": "PSNOW_GT_04",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day2/DAY2_PSNOW_GT_04_latest.tar"
  },
  {
   "day": 2,
   "product": "PSNOW_GT_08",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day2/DAY2_PSNOW_GT_08_latest.tar"
  },
  {
   "day": 2,
   "product": "PSNOW_GT_12",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day2/DAY2_PSNOW_GT_12_latest.tar"
  },
  {
   "day": 2,
   "product": "PICEZ_GT_25",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day2/DAY2_PICEZ_GT_25_latest.tar"
  },
  {
   "day": 3,
   "product": "PSNOW_GT_04",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day3/DAY3_PSNOW_GT_04_latest.tar"
  },
  {
   "day": 3,
   "product": "PSNOW_GT_08",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day3/DAY3_PSNOW_GT_08_latest.tar"
  },
  {
   "day": 3,
   "product": "PSNOW_GT_12",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day3/DAY3_PSNOW_GT_12_latest.tar"
  },
  {
   "day": 3,
   "product": "PICEZ_GT_25",
   "url": "https://ftp-wpc.ncep.noaa.gov/shapefiles/ww/day3/DAY3_PICEZ_GT_25_latest.tar"
  }
 ],
 "cpc": [
  {
   "index": 0,
   "label": "6-10 Day Precipitation",
   "url": "https://ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst/610prcp_latest.zip",
   "palette": "CPCPrecipOutlook"
  },
  {
   "index": 1,
   "label": "6-10 Day Temperature",
   "url": "https://ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst/610temp_latest.zip",
   "palette": "CPCTempOutlooks"
  },
  {
   "index": 2,
   "label": "8-14 Day Precipitation",
   "url": "https://ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst/814prcp_latest.zip",
   "palette": "CPCPrecipOutlook"
  },
  {
   "index": 3,
   "label": "8-14 Day Temperature",
   "url": "https://ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst/814temp_latest.zip",
   "palette": "CPCTempOutlooks"
  },
  {
   "index": 4,
   "label": "Monthly Precipitation",
   "url": "https://ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst/monthlyupdate/monthupd_prcp_latest.zip",
   "palette": "CPCPrecipOutlook"
  },
  {
   "index": 5,
   "label": "Monthly Temperature",
   "url": "https://ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst/monthlyupdate/monthupd_temp_latest.zip",
   "palette": "CPCTempOutlooks"
  }
 ],
 "spc": {
  "base": "https://www.spc.noaa.gov/",
  "styles": [
   "COCatTSTM",
   "COCatMRGL",
   "COCatSLGT",
   "COCatENH",
   "COCatMDT",
   "COCatHIGH",
   "COTorn2",
   "COTorn5",
   "COTorn10",
   "COTorn15",
   "COTorn30",
   "COTorn45",
   "COTorn60",
   "COWH5",
   "COWH15",
   "COWH30",
   "COWH45",
   "COWH60",
   "COCIG1",
   "COCIG2",
   "COCIG3",
   "COSigTorn",
   "COSigHail",
   "COSigWind"
  ],
  "text": {
   "day1": "https://tgftp.nws.noaa.gov/data/raw/ac/acus01.kwns.swo.dy1.txt",
   "day2": ".../acus02.kwns.swo.dy2.txt",
   "day3": ".../acus03.kwns.swo.dy3.txt",
   "day4-8": ".../acus48.kwns.swo.d48.txt"
  }
 },
 "md": {
  "spc": "https://www.spc.noaa.gov/products/spcmdrss.xml",
  "wpc": "https://tgftp.nws.noaa.gov/data/raw/aw/awus01.kwnh.ffg.mpd.txt",
  "keywords": {
   "Severe": [
    "SEVERE POTENTIAL",
    "SEVERE TSTM WATCH",
    "TORNADO WATCH"
   ],
   "Winter": [
    "WINTER MIXED PRECIP",
    "HEAVY SNOW",
    "BLIZZARD",
    "FREEZING RAIN"
   ],
   "HeavyRain": [
    "HEAVY RAINFALL"
   ]
  },
  "styles": [
   "MDSevere",
   "MDWinter",
   "MDHeavyRain"
  ]
 },
 "lsrTypes": [
  "Other",
  "Tornado",
  "Funnel Cloud",
  "Hail",
  "Non-Tstrm Wind Gust",
  "Non-Tstrm Wind Damage",
  "T-Strm Wind Gust",
  "T-Strm Wind Damage",
  "Marine T-Strm Wind",
  "High Sustained Wind",
  "Blizzard",
  "Snow/Heavy Snow",
  "Ice/Freezing Rain",
  "Sleet",
  "Heavy Rain",
  "Flood/Flash Flood",
  "Lightning",
  "Freeze"
 ],
 "lsrProbe": [
  "Local Storm Report",
  "Time:",
  "City:",
  "County/State:",
  "Position:",
  "Type:",
  "Magnitude:",
  "WFO:",
  "Source:",
  "Remark:"
 ],
 "tropical": {
  "layers": [
   "TropicalActiveSystemsOn",
   "TropicalBestTrackOn",
   "TropicalOfficialForecastOn",
   "TropicalNHCForecastConeOn",
   "TropicalForecastModelsOn",
   "TropicalWindRadiiOn",
   "TropicalForecastRadiiOn",
   "TropicalReconDataOn",
   "TropicalWatchesWarningsOn",
   "TropicalFormationProbabilitiesOn"
  ],
  "modelTrackTypes": [
   "Current Model Tracks",
   "Late Model Tracks",
   "GFS Ensemble Tracks"
  ],
  "styles": [
   "TropBestTrack",
   "TropForecastTrack",
   "NHCCone",
   "NHCTSWatch",
   "NHCTSWarn",
   "NHCHurWatch",
   "NHCHurWarn",
   "WindRadii34Kt",
   "WindRadii50Kt",
   "WindRadii64Kt",
   "GTwo0 (<40%)",
   "GTwo1 (40-60%)",
   "GTwo2 (>60%)"
  ],
  "infoPanel": [
   "Central Pressure: {p}mb",
   "Maximum Wind: {w}mph",
   "Storm Motion: {s}mph/{dir}"
  ]
 },
 "misc": {
  "diffFields": [
   "TMP:2 m above ground:1 hour fcst",
   "DPT:2 m above ground:1 hour fcst",
   "MSLMA:mean sea level"
  ],
  "diffUnits": [
   "°F",
   "°F",
   "mb"
  ],
  "eqProbe": [
   "Time:",
   "Magnitude:",
   "Depth: km"
  ],
  "fireProbe": [
   "Time:",
   "Source: VIIRS I-Band | MODIS (TERRA) | MODIS (AQUA)",
   "Brightness:",
   "Bright_T31:",
   "Confidence:"
  ],
  "fireStyles": [
   "FOElevated",
   "FOCritical",
   "FOExtreme",
   "FOIsoDryT",
   "FOScatDryT"
  ],
  "riverProbe": [
   "River Forecast for",
   "Valid time:",
   "Forecast Height:",
   "Action stage:",
   "Flood stage:",
   "Observation:",
   "Flow rate: kcfs"
  ]
 },
 "surface": {
  "metarFields": [
   "Temp",
   "Dew Pt",
   "Wind",
   "WX",
   "Alti",
   "Gust",
   "RH %",
   "W Chill",
   "Heat Idx"
  ],
  "marineFields": [
   "Continuous Winds (Sustained)",
   "Continuous Winds (Gust)",
   "Sustained Wind",
   "Wind Gust",
   "Air Temperature",
   "Water Temp",
   "Dew Pt",
   "MSLP",
   "Wave Height (ft)",
   "Wave Period"
  ],
  "metarProbe": [
   "METAR Report",
   "Station:",
   "Time:",
   "Temp:",
   "Dew Pt:",
   "Alti:",
   "Wind: mph",
   "Wind Gust:",
   "RH: %"
  ],
  "explorerTabs": [
   "Continuous Winds Data",
   "Standard Meteorological Data",
   "Spectral Wave Data",
   "Oceanographic Data"
  ],
  "explorerUnits": {
   "speed": [
    "mph",
    "kph",
    "knots",
    "m/s",
    "ft/s"
   ],
   "temp": [
    "°F",
    "°C",
    "°K"
   ],
   "pressure": [
    "inHg",
    "mb",
    "psi",
    "hPa"
   ],
   "distance": [
    "ft",
    "mi",
    "km",
    "m",
    "yd"
   ]
  }
 },
 "customRadarProducts": [
  "Reflectivity",
  "Base Velocity",
  "Spectrum Width",
  "ZDR",
  "PHI",
  "CC",
  "Base Velocity (Dealiased)",
  "Storm-Relative Velocity (Dealiased)"
 ],
 "modelConfigNames": [
  "GFS",
  "GFS025",
  "HRRR",
  "HRRR48Hr",
  "HiresFV3",
  "HiresWRF-ARW",
  "HiresWRF-NMMB",
  "NAM",
  "NAM3K",
  "NBM",
  "RAP",
  "RAP51Hr",
  "RRFS",
  "RRFS84Hr",
  "RRFSPressure",
  "CUSTOMGRIB (CUSTOMGRIB.dat)"
 ]
} as const;
export const XSECTIONS = {"tabs":[{"id":"section.basic","caption":"Basic","frame":"TBasicLayersFrame"},{"id":"section.world","caption":"World","frame":"TWorldLayersFrame"},{"id":"section.surface","caption":"Surface","frame":"TSurfaceLayersFrame"},{"id":"section.nexradpro","caption":"NEXRADPro","frame":"TRadarUIFrame"},{"id":"section.mrms","caption":"MRMS","frame":"TMRMSLayersFrame"},{"id":"section.model","caption":"Model","frame":"TModelLayersProFrame"},{"id":"section.meso","caption":"MESO","frame":"TMesoanalysisLayersFrame"},{"id":"section.forecast","caption":"Forecast","frame":"TForecastLayersFrame"},{"id":"section.ndfd","caption":"NDFD","frame":"TNDFDLayersFrame"},{"id":"section.nws-spc","caption":"NWS/SPC","frame":"TNWSLayersFrame"},{"id":"section.tropical","caption":"Tropical","frame":"TTropicalLayersFrame"},{"id":"section.winter","caption":"Winter","frame":"TWinterUIFrame"},{"id":"section.misc","caption":"Misc","frame":"TMiscellaneousLayersFrame"}]} as const;
