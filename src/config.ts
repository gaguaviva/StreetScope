const DEFAULT_CITY_LAYER_URL = 'https://services5.arcgis.com/54falWtcpty3V47Z/arcgis/rest/services/SalesForce311_View/FeatureServer'
const DEFAULT_LEGACY_CITY_LAYER_URL = 'https://services5.arcgis.com/54falWtcpty3V47Z/arcgis/rest/services/311_Repairs_WFL1/FeatureServer'

const env = import.meta.env

export const appConfig = {
  cityLayerUrl: (env.VITE_CITY_LAYER_URL || env.VITE_311_LAYER_URL || DEFAULT_CITY_LAYER_URL).trim(),
  legacyCityLayerUrl: (env.VITE_LEGACY_CITY_LAYER_URL || DEFAULT_LEGACY_CITY_LAYER_URL).trim(),
  reportApiUrl: (env.VITE_REPORT_API_URL || '').trim(),
  reportApiToken: (env.VITE_REPORT_API_TOKEN || '').trim(),
  supabaseUrl: (env.VITE_SUPABASE_URL || '').trim(),
  supabaseAnonKey: (env.VITE_SUPABASE_ANON_KEY || '').trim(),
  googleMapsApiKey: (env.VITE_GOOGLE_MAPS_API_KEY || '').trim(),
  googleMapsMapId: (env.VITE_GOOGLE_MAP_ID || '').trim(),
  cityDataSourceUrls: (env.VITE_CITY_DATASET_URLS || '')
    .split(';')
    .map((value: string) => value.trim())
    .filter((value: string) => Boolean(value)),
}

export const cityDataSourceUrls = appConfig.cityDataSourceUrls.length > 0
  ? appConfig.cityDataSourceUrls
  : [appConfig.cityLayerUrl, appConfig.legacyCityLayerUrl]
