import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent } from 'react'
import { CircleF, GoogleMap, InfoWindowF, useJsApiLoader } from '@react-google-maps/api'
import type { Libraries } from '@react-google-maps/api'
import { createClient } from '@supabase/supabase-js'
import { AlertCircle, ArrowDown, ArrowUpRight, ChevronDown, Crosshair, Filter, LocateFixed, MapPin, Plus, Radio, Search, X } from 'lucide-react'
import { appConfig } from './config'

type IssueType =
  | 'pothole'
  | 'streetlight'
  | 'construction'
  | 'sidewalk'
  | 'trash'
  | 'drainage'
  | 'water'
  | 'sewer'
  | 'animal'
  | 'parking'
  | 'park'
  | 'homeless'
  | 'other'
type Severity = 'low' | 'medium' | 'high'
type ReportStatus = 'open' | 'in-progress' | 'resolved' | 'cancelled'
type ReportSource = 'user' | 'city-of-sacramento'
type SourceFilter = 'all' | ReportSource
type StatusFilter = 'all' | ReportStatus | 'needs-attention'
interface Coordinates {
  latitude: number
  longitude: number
}

interface MapViewport {
  north: number
  south: number
  east: number
  west: number
  zoom: number
}

interface Report {
  id: string
  issue_type: IssueType
  description: string
  severity: Severity
  latitude: number
  longitude: number
  status: ReportStatus
  source: ReportSource
  created_at: string
  address?: string
  external_id?: string | null
  confirmation_count?: number
}

interface ArcGisFeatureCollection {
  features?: Array<{
    id?: string | number
    geometry?: { type: string; coordinates: number[] | number[][] }
    properties?: Record<string, unknown>
  }>
  error?: { message?: string }
  exceededTransferLimit?: boolean
}

interface ArcGisDateExtent {
  features?: Array<{ attributes?: { earliestDate?: number | null } }>
  error?: { message?: string }
}

const CITY_LAYER_URL = appConfig.cityLayerUrl
const LEGACY_CITY_LAYER_URL = appConfig.legacyCityLayerUrl
const CITY_CACHE_KEY = 'sacramento-city-repair-cache'
const CITY_CACHE_TTL_MS = 30 * 60 * 1000
const CITY_PAGE_SIZE = 2000
const MAX_CUMULATIVE_REPORTS = 10000
const CUMULATIVE_SAMPLE_PAGE_SIZE = 250
const CUMULATIVE_SAMPLE_CONCURRENCY = 5
const MAX_RENDERED_REPORT_MARKERS = 1000
const LOCAL_STORAGE_KEY = 'sacramento-infrastructure-reports'
const LOCAL_CONFIRMATIONS_KEY = 'sacramento-infrastructure-confirmations'
const CONFIRMER_ID_KEY = 'sacramento-infrastructure-confirmer-id'
const CONFIRMATION_THRESHOLD = 3
const NEARBY_RADIUS_KM = 5
const NEAR_DUPLICATE_RADIUS_KM = 1
const issueTypes: IssueType[] = [
  'pothole',
  'streetlight',
  'construction',
  'sidewalk',
  'trash',
  'drainage',
  'water',
  'sewer',
  'animal',
  'parking',
  'park',
  'homeless',
  'other',
]
const issueColors: Record<IssueType, string> = {
  pothole: '#ef8257',
  streetlight: '#e5ad4e',
  construction: '#6187d9',
  sidewalk: '#4ca98b',
  trash: '#6c8b4d',
  drainage: '#62a6c4',
  water: '#4b7ad6',
  sewer: '#7d5db0',
  animal: '#c46d6d',
  parking: '#d0a24d',
  park: '#3c8f67',
  homeless: '#8d5d44',
  other: '#7d8597',
}

const supabaseUrl = appConfig.supabaseUrl
const supabaseAnonKey = appConfig.supabaseAnonKey
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null
const googleMapsApiKey = appConfig.googleMapsApiKey
const googleMapsMapId = appConfig.googleMapsMapId || 'DEMO_MAP_ID'
const googleMapsLibraries: Libraries = ['marker']
const initialMapCenter: google.maps.LatLngLiteral = { lat: 38.5816, lng: -121.4944 }
const reportApiUrl = appConfig.reportApiUrl
const reportApiToken = appConfig.reportApiToken
let locationRequest: Promise<Coordinates> | null = null
let cityReportsRequest: Promise<Report[]> | null = null

function isReportArray(value: unknown): value is Report[] {
  return Array.isArray(value) && value.every((item) =>
    item !== null &&
    typeof item === 'object' &&
    typeof item.id === 'string' &&
    typeof item.latitude === 'number' &&
    typeof item.longitude === 'number' &&
    typeof item.description === 'string',
  )
}

function issueLabel(issueType: IssueType) {
  return {
    pothole: 'Pothole',
    streetlight: 'Street light',
    construction: 'Construction',
    sidewalk: 'Sidewalk',
    trash: 'Trash / solid waste',
    drainage: 'Drainage',
    water: 'Water',
    sewer: 'Sewer',
    animal: 'Animal control',
    parking: 'Parking',
    park: 'Parks / public space',
    homeless: 'Homeless encampment',
    other: 'Other',
  }[issueType]
}

function statusLabel(status: ReportStatus | 'needs-attention') {
  return {
    open: 'Open',
    'in-progress': 'In-progress',
    resolved: 'Resolved',
    cancelled: 'Cancelled',
    'needs-attention': 'Needs attention',
  }[status]
}

function reportAgeLabel(report: Report) {
  const createdTime = Date.parse(report.created_at)
  if (!Number.isFinite(createdTime)) return ''

  const ageInDays = Math.max(0, (Date.now() - createdTime) / (24 * 60 * 60 * 1000))
  if (ageInDays <= 7) return '1 week'
  if (ageInDays < 30) return 'under a month'
  if (ageInDays < 180) return 'under 6 months'
  return '6+ months to a year'
}

function sourceLabel(source: ReportSource) {
  return source === 'user' ? 'Community' : 'City of Sacramento'
}

function distanceInKilometers(from: Coordinates, to: Coordinates) {
  const radians = (degrees: number) => degrees * Math.PI / 180
  const latitudeDelta = radians(to.latitude - from.latitude)
  const longitudeDelta = radians(to.longitude - from.longitude)
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) *
    Math.sin(longitudeDelta / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

function getCurrentPosition(): Promise<Coordinates> {
  if (locationRequest) return locationRequest

  const request = new Promise<Coordinates>((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location access is not available in this browser.'))
      return
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
      (error) => reject(new Error(`Could not get your location: ${error.message}`)),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  })
  const pendingRequest = request.finally(() => {
    locationRequest = null
  })
  locationRequest = pendingRequest

  return pendingRequest
}

function formatReportLocation(location: Coordinates | null, locationLabel?: string | null) {
  const cleanedLabel = locationLabel?.trim()
  if (cleanedLabel) return cleanedLabel
  if (!location) return 'your current location'
  return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`
}

function buildAutoDescription(issueType: IssueType, location: Coordinates | null, locationLabel?: string | null) {
  return `Found a ${issueLabel(issueType).toLowerCase()} at ${formatReportLocation(location, locationLabel)}`
}

function reportLocationLabel(report: Report) {
  return `${report.latitude.toFixed(5)}, ${report.longitude.toFixed(5)}`
}

function isWithinDateRange(report: Report, startDate: string, endDate: string) {
  const reportTime = Date.parse(report.created_at)
  if (!Number.isFinite(reportTime)) return false

  const rangeStart = Date.parse(`${startDate}T00:00:00.000Z`)
  const rangeEndExclusive = Date.parse(`${endDate}T00:00:00.000Z`) + 24 * 60 * 60 * 1000
  return reportTime >= rangeStart && reportTime < rangeEndExclusive
}

function addDaysToDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
}

function daysBetweenDates(startDate: string, endDate: string) {
  return Math.max(0, Math.round((Date.parse(endDate) - Date.parse(startDate)) / (24 * 60 * 60 * 1000)))
}

function formatTimelineDate(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function coordinatesFor(feature: NonNullable<ArcGisFeatureCollection['features']>[number]) {
  const coordinates = feature.geometry?.coordinates
  if (!coordinates || coordinates.length === 0) return null

  if (typeof coordinates[0] === 'number') {
    const [longitude, latitude] = coordinates as number[]
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null
  }

  const points = coordinates as number[][]
  const validPoints = points.filter(([longitude, latitude]) => Number.isFinite(latitude) && Number.isFinite(longitude))
  if (validPoints.length === 0) return null
  const totals = validPoints.reduce(
    (result, [longitude, latitude]) => ({ latitude: result.latitude + latitude, longitude: result.longitude + longitude }),
    { latitude: 0, longitude: 0 },
  )
  return { latitude: totals.latitude / validPoints.length, longitude: totals.longitude / validPoints.length }
}

async function getLocationAddressLabel(location: Coordinates): Promise<string> {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(String(location.latitude))}&lon=${encodeURIComponent(String(location.longitude))}`,
    )
    if (!response.ok) throw new Error('Address lookup failed.')
    const result = await response.json() as { display_name?: string }
    const address = result.display_name?.trim()
    if (address) return address
  } catch (error) {
    console.warn('Reverse geocoding failed.', error)
  }

  return `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}`
}

function normalizeCityIssueType(categoryName: string, categoryLevel1?: string): IssueType {
  const combined = `${categoryName || ''} ${categoryLevel1 || ''}`.toLowerCase()

  if (combined.includes('pothole')) return 'pothole'
  if (combined.includes('street light') || combined.includes('street lighting') || combined.includes('streetlight')) return 'streetlight'
  if (combined.includes('sidewalk') || combined.includes('curb')) return 'sidewalk'
  if (combined.includes('construction') || combined.includes('roadwork') || combined.includes('road work')) return 'construction'
  if (combined.includes('street') && (combined.includes('repair') || combined.includes('maintenance'))) return 'pothole'
  if (combined.includes('drain') || combined.includes('stormwater') || combined.includes('ditch')) return 'drainage'
  if (combined.includes('sewer') || combined.includes('sanitary')) return 'sewer'
  if (combined.includes('water') || combined.includes('hydrant') || combined.includes('utility')) return 'water'
  if (combined.includes('trash') || combined.includes('dumping') || combined.includes('solid waste') || combined.includes('litter') || combined.includes('garbage')) return 'trash'
  if (combined.includes('animal') || combined.includes('pet')) return 'animal'
  if (combined.includes('parking') || combined.includes('parked') || combined.includes('parking meter')) return 'parking'
  if (combined.includes('park') || combined.includes('ranger') || combined.includes('playground') || combined.includes('tree')) return 'park'
  if (combined.includes('homeless') || combined.includes('encampment')) return 'homeless'
  if (combined.includes('street') || combined.includes('road') || combined.includes('sign') || combined.includes('traffic')) return 'construction'
  if (combined.includes('facility') || combined.includes('building') || combined.includes('permit') || combined.includes('planning')) return 'other'

  return 'other'
}

function normalizeCityStatus(status: string | null | undefined): ReportStatus {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'closed' || normalized === 'resolved') return 'resolved'
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled'
  if (normalized === 'in progress' || normalized === 'in-progress') return 'in-progress'
  return 'open'
}

async function fetchCityLayer(layer: number, signal: AbortSignal): Promise<Report[]> {
  const query = new URLSearchParams({
    where: '1=1',
    outFields: 'OBJECTID,CategoryName,CategoryLevel1,CategoryLevel2,PublicStatus,DateCreated,DateUpdated,Address,CrossStreet,Neighborhood',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '5',
    resultRecordCount: '1000',
    orderByFields: 'DateUpdated DESC',
    f: 'geojson',
  })
  const response = await fetch(`${CITY_LAYER_URL}/${layer}/query?${query}`, { signal })
  if (!response.ok) throw new Error(`City data request failed (${response.status}).`)

  const collection = await response.json() as ArcGisFeatureCollection
  if (collection.error) throw new Error(collection.error.message || 'The City of Sacramento data service returned an error.')

  return mapCityFeatures(collection, layer)
}

function mapCityFeatures(collection: ArcGisFeatureCollection, layer: number): Report[] {
  return (collection.features || []).flatMap((feature) => {
    const position = coordinatesFor(feature)
    if (!position) return []

    const properties = feature.properties || {}
    const categoryName = String(properties.CategoryName || '').trim()
    const categoryLevel1 = typeof properties.CategoryLevel1 === 'string' ? properties.CategoryLevel1 : ''
    const issueType = normalizeCityIssueType(categoryName, categoryLevel1)

    const dateCreated = Number(properties.DateCreated)
    const date = Number.isFinite(dateCreated) && dateCreated > 0 ? new Date(dateCreated) : new Date()
    const address = typeof properties.Address === 'string' ? properties.Address.trim() : ''
    const crossStreet = typeof properties.CrossStreet === 'string' ? properties.CrossStreet.trim() : ''
    const neighborhood = typeof properties.Neighborhood === 'string' ? properties.Neighborhood.trim() : ''
    const location = [address, crossStreet, neighborhood].filter(Boolean).join(' · ')
    const status = normalizeCityStatus(typeof properties.PublicStatus === 'string' ? properties.PublicStatus : null)

    return [{
      id: `city-${layer}-${String(properties.OBJECTID ?? feature.id ?? crypto.randomUUID())}`,
      external_id: String(properties.OBJECTID ?? feature.id ?? ''),
      issue_type: issueType,
      severity: 'medium' as const,
      description: `${categoryName || issueLabel(issueType)} reported by the City${location ? ` at ${location}` : ''}.`,
      latitude: position.latitude,
      longitude: position.longitude,
      status,
      source: 'city-of-sacramento' as const,
      created_at: date.toISOString(),
      address: location || undefined,
    }]
  })
}

async function fetchCityTimelineStart(signal: AbortSignal): Promise<string> {
  const query = new URLSearchParams({
    where: '1=1',
    outStatistics: JSON.stringify([{
      statisticType: 'min',
      onStatisticField: 'DateCreated',
      outStatisticFieldName: 'earliestDate',
    }]),
    returnGeometry: 'false',
    f: 'json',
  })
  const response = await fetch(`${CITY_LAYER_URL}/0/query?${query}`, { signal })
  if (!response.ok) throw new Error(`City date range request failed (${response.status}).`)

  const result = await response.json() as ArcGisDateExtent
  if (result.error) throw new Error(result.error.message || 'The City of Sacramento date range could not be loaded.')
  const earliestDate = result.features?.[0]?.attributes?.earliestDate
  if (typeof earliestDate !== 'number' || !Number.isFinite(earliestDate)) {
    throw new Error('The City of Sacramento data source did not return a valid historical date range.')
  }
  return new Date(earliestDate).toISOString().slice(0, 10)
}

async function fetchHistoricalCityReports(
  startDate: string,
  endDate: string,
  signal: AbortSignal,
): Promise<{ reports: Report[]; sampled: boolean }> {
  const endExclusive = new Date(Date.parse(`${endDate}T00:00:00.000Z`) + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
  const where = `DateCreated >= TIMESTAMP '${startDate} 00:00:00' AND DateCreated < TIMESTAMP '${endExclusive} 00:00:00'`
  const countQuery = new URLSearchParams({
    where,
    returnCountOnly: 'true',
    f: 'json',
  })
  const countResponse = await fetch(`${CITY_LAYER_URL}/0/query?${countQuery}`, { signal })
  if (!countResponse.ok) throw new Error(`Historical City count request failed (${countResponse.status}).`)

  const countResult = await countResponse.json() as { count?: number; error?: { message?: string } }
  if (countResult.error) throw new Error(countResult.error.message || 'Historical City report count could not be loaded.')
  if (typeof countResult.count !== 'number' || !Number.isFinite(countResult.count)) {
    throw new Error('The City data source returned an invalid historical report count.')
  }
  const totalCount = countResult.count

  const sampled = totalCount > MAX_CUMULATIVE_REPORTS &&
    Date.parse(endDate) - Date.parse(startDate) >= 24 * 60 * 60 * 1000
  const pageSize = sampled ? CUMULATIVE_SAMPLE_PAGE_SIZE : CITY_PAGE_SIZE
  const pageCount = sampled
    ? Math.ceil(MAX_CUMULATIVE_REPORTS / pageSize)
    : Math.ceil(totalCount / pageSize)
  const pageOffsets = sampled
    ? Array.from({ length: pageCount }, (_, index) =>
        Math.round(index * (totalCount - pageSize) / (pageCount - 1)),
      )
    : Array.from({ length: pageCount }, (_, index) => index * pageSize)
  const reports: Report[] = []

  for (let batchStart = 0; batchStart < pageOffsets.length; batchStart += CUMULATIVE_SAMPLE_CONCURRENCY) {
    const batchOffsets = pageOffsets.slice(batchStart, batchStart + CUMULATIVE_SAMPLE_CONCURRENCY)
    const collections = await Promise.all(batchOffsets.map(async (resultOffset) => {
      const query = new URLSearchParams({
        where,
        outFields: 'OBJECTID,CategoryName,CategoryLevel1,CategoryLevel2,PublicStatus,DateCreated,DateUpdated,Address,CrossStreet,Neighborhood',
        returnGeometry: 'true',
        outSR: '4326',
        geometryPrecision: '5',
        resultRecordCount: String(Math.min(pageSize, totalCount - resultOffset)),
        resultOffset: String(resultOffset),
        orderByFields: 'DateCreated DESC, OBJECTID DESC',
        f: 'geojson',
      })
      const response = await fetch(`${CITY_LAYER_URL}/0/query?${query}`, { signal })
      if (!response.ok) throw new Error(`Historical City data request failed (${response.status}).`)

      const collection = await response.json() as ArcGisFeatureCollection
      if (collection.error) throw new Error(collection.error.message || 'Historical City data could not be loaded.')
      return collection
    }))
    collections.forEach((collection) => reports.push(...mapCityFeatures(collection, 0)))
  }

  return { reports, sampled }
}

async function fetchLegacyCityLayer(layer: number, signal: AbortSignal): Promise<Report[]> {
  const query = new URLSearchParams({
    where: '1=1',
    outFields: 'OBJECTID,CategoryName,DateCreated,CrossStreet,Neighborhood',
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '5',
    resultRecordCount: '100',
    orderByFields: 'DateUpdated DESC',
    f: 'geojson',
  })
  const response = await fetch(`${LEGACY_CITY_LAYER_URL}/${layer}/query?${query}`, { signal })
  if (!response.ok) throw new Error(`Legacy city data request failed (${response.status}).`)

  const collection = await response.json() as ArcGisFeatureCollection
  if (collection.error) throw new Error(collection.error.message || 'The legacy Sacramento city data service returned an error.')

  return (collection.features || []).flatMap((feature) => {
    const position = coordinatesFor(feature)
    if (!position) return []

    const properties = feature.properties || {}
    const category = String(properties.CategoryName || (layer === 1 ? 'Pothole' : 'Street light')).toLowerCase()
    const issueType: IssueType = category.includes('pothole') ? 'pothole' : 'streetlight'
    const dateCreated = Number(properties.DateCreated)
    const date = Number.isFinite(dateCreated) && dateCreated > 0 ? new Date(dateCreated) : new Date()
    const crossStreet = typeof properties.CrossStreet === 'string' ? properties.CrossStreet : ''
    const neighborhood = typeof properties.Neighborhood === 'string' ? properties.Neighborhood : ''
    const location = [crossStreet, neighborhood].filter(Boolean).join(' · ')

    return [{
      id: `legacy-city-${layer}-${String(properties.OBJECTID ?? feature.id ?? crypto.randomUUID())}`,
      external_id: String(properties.OBJECTID ?? feature.id ?? ''),
      issue_type: issueType,
      severity: 'medium' as const,
      description: `${issueType === 'pothole' ? 'Pothole repair' : 'Street light repair'} recorded by the City${location ? ` near ${location}` : ''}.`,
      latitude: position.latitude,
      longitude: position.longitude,
      status: 'resolved' as const,
      source: 'city-of-sacramento' as const,
      created_at: date.toISOString(),
      address: location || undefined,
    }]
  })
}

async function fetchCityReports(signal: AbortSignal) {
  const [current311, legacyStreetLights, legacyPotholes] = await Promise.all([
    fetchCityLayer(0, signal),
    fetchLegacyCityLayer(0, signal),
    fetchLegacyCityLayer(1, signal),
  ])
  return [...legacyPotholes, ...legacyStreetLights, ...current311]
}

function getCachedCityReports() {
  try {
    const cached: unknown = JSON.parse(localStorage.getItem(CITY_CACHE_KEY) || 'null')
    if (
      cached !== null &&
      typeof cached === 'object' &&
      'savedAt' in cached &&
      typeof cached.savedAt === 'number' &&
      Date.now() - cached.savedAt < CITY_CACHE_TTL_MS &&
      'reports' in cached &&
      isReportArray(cached.reports) &&
      cached.reports.every((report) => report.source === 'city-of-sacramento')
    ) {
      return cached.reports
    }
  } catch (error) {
    console.warn('Unable to read cached City of Sacramento reports.', error)
  }
  return null
}

function cacheCityReports(reports: Report[]) {
  try {
    localStorage.setItem(CITY_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), reports }))
  } catch (error) {
    console.warn('Unable to cache City of Sacramento reports.', error)
  }
}

function loadCityReports() {
  if (!cityReportsRequest) {
    const controller = new AbortController()
    cityReportsRequest = fetchCityReports(controller.signal)
      .then((reports) => {
        cacheCityReports(reports)
        return reports
      })
      .finally(() => {
        cityReportsRequest = null
      })
  }
  return cityReportsRequest
}

async function submitReportToApi(report: Report) {
  if (!reportApiUrl) return

  const response = await fetch(reportApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': reportApiToken,
      Authorization: `Bearer ${reportApiToken}`,
    },
    body: JSON.stringify({
      source: 'street-scope',
      report,
      submitted_at: new Date().toISOString(),
      api_key: reportApiToken,
    }),
  })

  if (!response.ok) {
    throw new Error(`Report API request failed (${response.status}).`)
  }
}

function getOrCreateConfirmerId() {
  const storedId = localStorage.getItem(CONFIRMER_ID_KEY)
  if (storedId) return storedId

  const confirmerId = crypto.randomUUID()
  localStorage.setItem(CONFIRMER_ID_KEY, confirmerId)
  return confirmerId
}

function readConfirmedReportIds() {
  const savedIds: unknown = JSON.parse(localStorage.getItem(LOCAL_CONFIRMATIONS_KEY) || '[]')
  if (!Array.isArray(savedIds) || !savedIds.every((id) => typeof id === 'string')) {
    throw new Error('Saved confirmations have an unexpected format.')
  }
  return savedIds.filter((id): id is string => typeof id === 'string')
}

function MapControls({
  map,
  location,
  onLocationFound,
  onLocationError,
}: {
  map: google.maps.Map
  location: Coordinates | null
  onLocationFound: (location: Coordinates) => void
  onLocationError: (message: string) => void
}) {
  const [zoom, setZoom] = useState(map.getZoom() ?? 13)
  const [isLocating, setIsLocating] = useState(false)

  useEffect(() => {
    const zoomListener = map.addListener('zoom_changed', () => setZoom(map.getZoom() ?? 13))
    return () => {
      google.maps.event.removeListener(zoomListener)
    }
  }, [map])

  async function recenterOnMyLocation() {
    onLocationError('')
    if (location) {
      map.panTo({ lat: location.latitude, lng: location.longitude })
      map.setZoom(15)
      return
    }

    setIsLocating(true)
    try {
      const currentLocation = await getCurrentPosition()
      onLocationFound(currentLocation)
      map.panTo({ lat: currentLocation.latitude, lng: currentLocation.longitude })
      map.setZoom(15)
    } catch (error) {
      onLocationError(error instanceof Error ? error.message : 'Unable to get your location.')
    } finally {
      setIsLocating(false)
    }
  }

  return (
    <div className="map-controls">
      <button
        className="map-control"
        type="button"
        aria-label="Recenter map on my location"
        title="Recenter map on my location"
        onClick={() => void recenterOnMyLocation()}
        disabled={isLocating}
      >
        {isLocating ? <span className="button-spinner" /> : <Crosshair size={17} />}
      </button>
      <button
        className="map-control map-zoom-control"
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => map.setZoom(zoom + 1)}
        disabled={zoom >= 18}
      >
        +
      </button>
      <button
        className="map-control map-zoom-control"
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => map.setZoom(zoom - 1)}
        disabled={zoom <= 10}
      >
        -
      </button>
    </div>
  )
}

interface GoogleMapSurfaceProps {
  isPlacing: boolean
  onMapSelect: (latitude: number, longitude: number) => void
  deviceLocation: Coordinates | null
  onLocationFound: (location: Coordinates) => void
  onLocationError: (message: string) => void
  selectedReport: Report | null
  isNearMeActive: boolean
  nearMeLocation: Coordinates | null
  locationLabel: string
  reports: Report[]
  draftLocation: Coordinates | null
  issueType: IssueType
  confirmedReportIds: Set<string>
  confirmingReportIds: Set<string>
  confirmationErrors: Record<string, string>
  confirmationSetupError: string
  onConfirm: (report: Report) => void
}

function GoogleMapSurface(props: GoogleMapSurfaceProps) {
  if (!googleMapsApiKey) {
    return (
      <div className="map-api-message" role="status">
        <strong>Google Maps API key required</strong>
        <span>Add <code>VITE_GOOGLE_MAPS_API_KEY</code> to <code>.env.local</code>, then restart the app.</span>
      </div>
    )
  }

  return <LoadedGoogleMap {...props} />
}

function ReportAdvancedMarker({
  map,
  report,
  isOpen,
  onClick,
  onClose,
  hasConfirmed,
  isConfirming,
  confirmationError,
  onConfirm,
}: {
  map: google.maps.Map
  report: Report
  isOpen: boolean
  onClick: (reportId: string) => void
  onClose: () => void
  hasConfirmed: boolean
  isConfirming: boolean
  confirmationError?: string
  onConfirm: () => void
}) {
  const color = issueColors[report.issue_type]
  const outlineColor = report.status === 'resolved'
    ? '#278248'
    : report.status === 'cancelled'
      ? '#454b46'
      : '#d52f36'
  const glyphText = report.status === 'open'
    ? 'X'
    : report.status === 'in-progress'
      ? '!'
      : report.status === 'resolved'
        ? '✓'
        : '–'
  const reportPosition = { lat: report.latitude, lng: report.longitude }

  useEffect(() => {
    let active = true
    let marker: google.maps.marker.AdvancedMarkerElement | null = null
    const handleClick = () => onClick(report.id)

    void google.maps.importLibrary('marker').then(({ AdvancedMarkerElement, PinElement }) => {
      if (!active) return

      const pin = new PinElement({
        background: color,
        borderColor: outlineColor,
        glyphColor: '#ffffff',
        glyphText,
        scale: report.source === 'user' ? 1.55 : 1.4,
      })
      pin.style.filter = [
        'drop-shadow(1px 0 0 #111111)',
        'drop-shadow(-1px 0 0 #111111)',
        'drop-shadow(0 1px 0 #111111)',
        'drop-shadow(0 -1px 0 #111111)',
        'drop-shadow(2px 0 0 #111111)',
        'drop-shadow(-2px 0 0 #111111)',
        'drop-shadow(0 2px 0 #111111)',
        'drop-shadow(0 -2px 0 #111111)',
      ].join(' ')
      marker = new AdvancedMarkerElement({
        map,
        position: reportPosition,
        title: `${issueLabel(report.issue_type)} · ${statusLabel(report.status)}`,
        content: pin,
        gmpClickable: true,
      })
      marker.addEventListener('gmp-click', handleClick)
    })

    return () => {
      active = false
      if (marker) {
        marker.removeEventListener('gmp-click', handleClick)
        marker.map = null
      }
    }
  }, [map, report, color, onClick])

  const confirmationCount = report.confirmation_count ?? 0
  const isConfirmed = confirmationCount >= CONFIRMATION_THRESHOLD
  const reportDate = new Date(report.created_at).toLocaleDateString()
  const reportTime = new Date(report.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return (
    <>
      {isOpen && (
        <InfoWindowF
          position={reportPosition}
          onCloseClick={onClose}
          options={{ maxWidth: 320 }}
        >
          <div className="popup-content">
            <div className="popup-topline">
              <span className="popup-dot" style={{ backgroundColor: color }} />
              <strong>{issueLabel(report.issue_type)}</strong>
              <span className="popup-time">{reportTime}</span>
              <span className={`popup-status ${report.status}`}>{statusLabel(report.status)}</span>
            </div>
            {report.status !== 'resolved' && <span className="popup-age">{reportAgeLabel(report)}</span>}
            {report.source === 'user' && (
              <div className={`report-confirmation ${isConfirmed ? 'confirmed' : 'unconfirmed'}`}>
                <span>{isConfirmed ? `Confirmed by ${confirmationCount} people` : `Unconfirmed · ${confirmationCount}/${CONFIRMATION_THRESHOLD} confirmations`}</span>
                {report.status !== 'resolved' && (
                  <button type="button" onClick={onConfirm} disabled={hasConfirmed || isConfirming}>
                    {isConfirming ? 'Confirming…' : hasConfirmed ? 'You confirmed this report' : 'Confirm this report'}
                  </button>
                )}
                {confirmationError && <span className="confirmation-error" role="alert">{confirmationError}</span>}
              </div>
            )}
            <p>{report.description}</p>
            <div className="popup-meta">
              <span>Found at {reportLocationLabel(report)}</span>
              <div className="popup-meta-row">
                <span className="popup-meta-source">{sourceLabel(report.source)}</span>
                <span className="popup-meta-date">{reportDate}</span>
              </div>
            </div>
          </div>
        </InfoWindowF>
      )}
    </>
  )
}

function LocationAdvancedMarker({
  map,
  location,
  label,
  onClick,
}: {
  map: google.maps.Map
  location: Coordinates
  label: string
  onClick: () => void
}) {
  useEffect(() => {
    let active = true
    let marker: google.maps.marker.AdvancedMarkerElement | null = null

    void google.maps.importLibrary('marker').then(({ AdvancedMarkerElement, PinElement }) => {
      if (!active) return

      const pin = new PinElement({
        background: '#567052',
        borderColor: '#ffffff',
        glyphColor: '#ffffff',
        glyphText: '•',
      })
      marker = new AdvancedMarkerElement({
        map,
        position: { lat: location.latitude, lng: location.longitude },
        title: label,
        content: pin,
        gmpClickable: true,
      })
      marker.addEventListener('gmp-click', onClick)
    })

    return () => {
      active = false
      if (marker) {
        marker.removeEventListener('gmp-click', onClick)
        marker.map = null
      }
    }
  }, [map, location, label, onClick])

  return null
}

function LoadedGoogleMap({
  isPlacing,
  onMapSelect,
  deviceLocation,
  onLocationFound,
  onLocationError,
  selectedReport,
  isNearMeActive,
  nearMeLocation,
  locationLabel,
  reports,
  draftLocation,
  issueType,
  confirmedReportIds,
  confirmingReportIds,
  confirmationErrors,
  confirmationSetupError,
  onConfirm,
}: GoogleMapSurfaceProps) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-maps-script',
    googleMapsApiKey,
    libraries: googleMapsLibraries,
  })
  const [map, setMap] = useState<google.maps.Map | null>(null)
  const [openReportId, setOpenReportId] = useState<string | null>(null)
  const [locationInfoOpen, setLocationInfoOpen] = useState(false)
  const [viewport, setViewport] = useState<MapViewport | null>(null)
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapInstanceRef = useRef<google.maps.Map | null>(null)
  const lastFitTarget = useRef<string | null>(null)
  const lastViewportKey = useRef<string | null>(null)
  const visibleReports = useMemo(() => {
    if (!viewport) return []
    return reports.filter((report) =>
      report.latitude >= viewport.south &&
      report.latitude <= viewport.north &&
      report.longitude >= viewport.west &&
      report.longitude <= viewport.east,
    )
  }, [reports, viewport])
  const markerReports = useMemo(() => {
    if (visibleReports.length <= MAX_RENDERED_REPORT_MARKERS) return visibleReports

    const chronologicalReports = [...visibleReports].sort((first, second) =>
      Date.parse(first.created_at) - Date.parse(second.created_at),
    )
    const interval = (chronologicalReports.length - 1) / (MAX_RENDERED_REPORT_MARKERS - 1)
    return Array.from({ length: MAX_RENDERED_REPORT_MARKERS }, (_, index) =>
      chronologicalReports[Math.round(index * interval)],
    )
  }, [visibleReports])
  const mapOptions: google.maps.MapOptions = {
    minZoom: 10,
    maxZoom: 18,
    mapTypeId: 'roadmap',
    mapId: googleMapsMapId,
    disableDefaultUI: true,
    clickableIcons: false,
    draggableCursor: isPlacing ? 'crosshair' : undefined,
  }

  useEffect(() => {
    if (!map || !mapContainerRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const currentCenter = map.getCenter()
      google.maps.event.trigger(map, 'resize')
      if (currentCenter) map.setCenter(currentCenter)
    })
    observer.observe(mapContainerRef.current)
    return () => observer.disconnect()
  }, [map])

  useEffect(() => {
    if (!map || !selectedReport) return
    map.panTo({ lat: selectedReport.latitude, lng: selectedReport.longitude })
    map.setZoom(15)
  }, [map, selectedReport])

  useEffect(() => {
    if (!map || !isNearMeActive || !nearMeLocation) {
      lastFitTarget.current = null
      return
    }

    const fitTarget = `${nearMeLocation.latitude},${nearMeLocation.longitude}`
    if (lastFitTarget.current === fitTarget) return
    lastFitTarget.current = fitTarget

    if (reports.length > 0) {
      const bounds = new google.maps.LatLngBounds()
      bounds.extend({ lat: nearMeLocation.latitude, lng: nearMeLocation.longitude })
      reports.forEach((report) => bounds.extend({ lat: report.latitude, lng: report.longitude }))
      map.fitBounds(bounds, 36)
      google.maps.event.addListenerOnce(map, 'idle', () => {
        if ((map.getZoom() ?? 0) > 15) map.setZoom(15)
      })
    } else {
      map.setCenter({ lat: nearMeLocation.latitude, lng: nearMeLocation.longitude })
      map.setZoom(15)
    }
  }, [map, isNearMeActive, nearMeLocation, reports])

  if (loadError) {
    return <div className="map-api-message" role="alert">Google Maps could not load: {loadError.message}</div>
  }
  if (!isLoaded) {
    return <div className="map-api-message" role="status">Loading Google Maps…</div>
  }

  return (
    <div className="google-map-shell" ref={mapContainerRef}>
      <GoogleMap
        mapContainerClassName={isPlacing ? 'google-map placing' : 'google-map'}
        center={initialMapCenter}
        zoom={13}
        options={mapOptions}
        onLoad={(loadedMap) => {
          mapInstanceRef.current = loadedMap
          setMap(loadedMap)
        }}
        onUnmount={() => {
          mapInstanceRef.current = null
          setMap(null)
        }}
        onClick={(event) => {
          if (isPlacing && event.latLng) onMapSelect(event.latLng.lat(), event.latLng.lng())
        }}
        onIdle={() => {
          const currentMap = mapInstanceRef.current
          if (!currentMap) return
          const bounds = currentMap.getBounds()
          if (!bounds) return
          const northEast = bounds.getNorthEast()
          const southWest = bounds.getSouthWest()
          const nextViewport: MapViewport = {
            north: northEast.lat(),
            east: northEast.lng(),
            south: southWest.lat(),
            west: southWest.lng(),
            zoom: currentMap.getZoom() ?? 13,
          }
          const viewportKey = Object.values(nextViewport).map((value) => value.toFixed(4)).join(',')
          if (lastViewportKey.current === viewportKey) return
          lastViewportKey.current = viewportKey
          setViewport(nextViewport)
        }}
      >
        {nearMeLocation && (
          <>
            <CircleF
              center={{ lat: nearMeLocation.latitude, lng: nearMeLocation.longitude }}
              radius={42}
              options={{ strokeColor: '#567052', strokeOpacity: 0.7, strokeWeight: 2, fillColor: '#567052', fillOpacity: 0.12, clickable: false }}
            />
            {map && (
              <LocationAdvancedMarker
                map={map}
                location={nearMeLocation}
                label={locationLabel || 'Your location'}
                onClick={() => setLocationInfoOpen(true)}
              />
            )}
            {locationInfoOpen && (
              <InfoWindowF
                position={{ lat: nearMeLocation.latitude, lng: nearMeLocation.longitude }}
                onCloseClick={() => setLocationInfoOpen(false)}
              >
                <div className="popup-content">
                  <div className="popup-topline">
                    <span className="popup-dot" style={{ backgroundColor: '#567052' }} />
                    <strong>{locationLabel || 'Your location'}</strong>
                  </div>
                </div>
              </InfoWindowF>
            )}
          </>
        )}
        {map && markerReports.map((report) => (
          <ReportAdvancedMarker
            key={report.id}
            map={map}
            report={report}
            isOpen={openReportId === report.id}
            onClick={setOpenReportId}
            onClose={() => setOpenReportId(null)}
            hasConfirmed={confirmedReportIds.has(report.id)}
            isConfirming={confirmingReportIds.has(report.id)}
            confirmationError={confirmationErrors[report.id] || confirmationSetupError}
            onConfirm={() => onConfirm(report)}
          />
        ))}
        {draftLocation && (
          <CircleF
            center={{ lat: draftLocation.latitude, lng: draftLocation.longitude }}
            radius={24}
            options={{ strokeColor: '#282b26', strokeOpacity: 0.85, strokeWeight: 3, fillColor: issueColors[issueType], fillOpacity: 0.5, clickable: false }}
          />
        )}
      </GoogleMap>
      {map && (
        <MapControls
          map={map}
          location={deviceLocation}
          onLocationFound={onLocationFound}
          onLocationError={onLocationError}
        />
      )}
    </div>
  )
}

function App() {
  const [cityReports, setCityReports] = useState<Report[]>([])
  const [historicalCityReports, setHistoricalCityReports] = useState<Report[]>([])
  const [cityStartDate, setCityStartDate] = useState<string | null>(null)
  const [userReports, setUserReports] = useState<Report[]>([])
  const [confirmerId, setConfirmerId] = useState('')
  const [confirmedReportIds, setConfirmedReportIds] = useState<Set<string>>(new Set())
  const [confirmingReportIds, setConfirmingReportIds] = useState<Set<string>>(new Set())
  const [confirmationErrors, setConfirmationErrors] = useState<Record<string, string>>({})
  const [confirmationSetupError, setConfirmationSetupError] = useState('')
  const [cityLoading, setCityLoading] = useState(true)
  const [initialCityLoading, setInitialCityLoading] = useState(true)
  const [reportsLoading, setReportsLoading] = useState(true)
  const [cityError, setCityError] = useState('')
  const [reportsError, setReportsError] = useState('')
  const [typeFilter, setTypeFilter] = useState<IssueType | 'all'>('all')
  const [visibleIssueTypes, setVisibleIssueTypes] = useState<IssueType[]>(issueTypes)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [timelineStartDate, setTimelineStartDate] = useState(() =>
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  )
  const [timelineEndDate, setTimelineEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [selectedTimelineDate, setSelectedTimelineDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [timelineDisplayMode, setTimelineDisplayMode] = useState<'day' | 'cumulative'>('day')
  const [historicalIsSampled, setHistoricalIsSampled] = useState(false)
  const [deviceLocation, setDeviceLocation] = useState<Coordinates | null>(null)
  const [nearMeLocation, setNearMeLocation] = useState<Coordinates | null>(null)
  const [isNearMeActive, setIsNearMeActive] = useState(false)
  const [isLocating, setIsLocating] = useState(false)
  const [nearMeError, setNearMeError] = useState('')
  const [addressQuery, setAddressQuery] = useState('')
  const [isGeocoding, setIsGeocoding] = useState(false)
  const [addressError, setAddressError] = useState('')
  const [isPlacing, setIsPlacing] = useState(false)
  const [draftLocation, setDraftLocation] = useState<{ latitude: number; longitude: number } | null>(null)
  const [description, setDescription] = useState('')
  const [issueType, setIssueType] = useState<IssueType>('pothole')
  const [severity, setSeverity] = useState<Severity>('medium')
  const [isSaving, setIsSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [duplicateReport, setDuplicateReport] = useState<Report | null>(null)
  const [reportPanelOpen, setReportPanelOpen] = useState(false)
  const [reportPanelPosition, setReportPanelPosition] = useState({ x: 18, y: 78 })
  const [myReportsOpen, setMyReportsOpen] = useState(false)
  const [reportPendingDeletion, setReportPendingDeletion] = useState<string | null>(null)
  const [deleteReportError, setDeleteReportError] = useState('')
  const [selectedMyReportId, setSelectedMyReportId] = useState<string | null>(null)
  const reportPanelRef = useRef<HTMLDivElement | null>(null)
  const reportDragOffset = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    try {
      setConfirmerId(getOrCreateConfirmerId())
      setConfirmedReportIds(new Set(readConfirmedReportIds()))
    } catch (error) {
      setConfirmationSetupError(error instanceof Error ? error.message : 'Unable to load saved confirmations.')
    }
  }, [])

  useEffect(() => {
    if (!isPlacing) return

    const handlePointerMove = (event: PointerEvent) => {
      if (!reportDragOffset.current || !reportPanelRef.current) return
      const container = reportPanelRef.current.parentElement
      if (!container) return

      const bounds = container.getBoundingClientRect()
      const nextX = Math.min(
        Math.max(event.clientX - bounds.left - reportDragOffset.current.x, 12),
        Math.max(bounds.width - reportPanelRef.current.offsetWidth - 12, 12),
      )
      const nextY = Math.min(
        Math.max(event.clientY - bounds.top - reportDragOffset.current.y, 12),
        Math.max(bounds.height - reportPanelRef.current.offsetHeight - 12, 12),
      )

      setReportPanelPosition({ x: nextX, y: nextY })
    }

    const handlePointerUp = () => {
      reportDragOffset.current = null
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [isPlacing])

  useEffect(() => {
    let active = true
    setIsLocating(true)
    setNearMeError('')

    void getCurrentPosition()
      .then((location) => {
        if (active) {
          setDeviceLocation(location)
          setNearMeLocation(location)
          setIsNearMeActive(true)
        }
      })
      .catch((error: unknown) => {
        if (active) setNearMeError(error instanceof Error ? error.message : 'Unable to get your location.')
      })
      .finally(() => {
        if (active) setIsLocating(false)
      })

    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!draftLocation) return
    setDescription((current) => {
      const trimmed = current.trim()
      if (trimmed && !current.startsWith('Found a ')) return current
      return buildAutoDescription(issueType, draftLocation, addressQuery.trim() || null)
    })
  }, [draftLocation, issueType, addressQuery])

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const cachedReports = getCachedCityReports()
    Promise.all([
      cachedReports ? Promise.resolve(cachedReports) : loadCityReports(),
      fetchCityTimelineStart(controller.signal),
    ])
      .then(([reports, startDate]) => {
        if (!active) return
        setCityReports(reports)
        setCityStartDate(startDate)
      })
      .catch((error: unknown) => {
        if (active) setCityError(error instanceof Error ? error.message : 'Unable to load City of Sacramento data.')
      })
      .finally(() => {
        if (active) setCityLoading(false)
        if (active) setInitialCityLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [])

  useEffect(() => {
    let active = true
    async function loadReports() {
      try {
        if (supabase) {
          const { data, error } = await supabase
            .from('reports')
            .select('id, issue_type, description, severity, latitude, longitude, status, source, created_at, external_id, confirmation_count')
            .eq('source', 'user')
            .order('created_at', { ascending: false })
            .limit(1000)
          if (error) throw new Error(`Could not load saved reports: ${error.message}`)
          if (active) {
            setUserReports((data || []).map((row) => ({
              id: row.id,
              issue_type: row.issue_type as IssueType,
              description: row.description,
              severity: row.severity as Severity,
              latitude: row.latitude,
              longitude: row.longitude,
              status: row.status as ReportStatus,
              source: 'user',
              created_at: row.created_at,
              external_id: row.external_id,
              confirmation_count: row.confirmation_count ?? 0,
            })))
          }
        } else {
          const savedReports: unknown = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]')
          if (!isReportArray(savedReports)) throw new Error('Saved reports have an unexpected format. Clear the browser storage and try again.')
          if (active) setUserReports(savedReports.map((report) => ({
            ...report,
            confirmation_count: report.confirmation_count ?? 0,
          })))
        }
      } catch (error) {
        if (active) setReportsError(error instanceof Error ? error.message : 'Unable to load saved reports.')
      } finally {
        if (active) setReportsLoading(false)
      }
    }

    void loadReports()
    return () => { active = false }
  }, [])

  const reports = useMemo(() => {
    const reportsById = new Map<string, Report>()
    for (const report of [...cityReports, ...historicalCityReports, ...userReports]) {
      reportsById.set(report.id, report)
    }
    return [...reportsById.values()]
  }, [userReports, cityReports, historicalCityReports])
  const timelineDayCount = daysBetweenDates(timelineStartDate, timelineEndDate)
  const selectedTimelineOffset = Math.min(
    timelineDayCount,
    Math.max(0, daysBetweenDates(timelineStartDate, selectedTimelineDate)),
  )
  const activeTimelineDate = addDaysToDate(timelineStartDate, selectedTimelineOffset)
  const historicalQueryStartDate = timelineDisplayMode === 'cumulative'
    ? timelineStartDate
    : activeTimelineDate
  const historicalQueryEndDate = timelineDisplayMode === 'cumulative'
    ? timelineEndDate
    : activeTimelineDate

  useEffect(() => {
    if (!cityStartDate || !historicalQueryStartDate || !historicalQueryEndDate) return

    let active = true
    const controller = new AbortController()
    setCityLoading(true)
    setCityError('')
    const timer = window.setTimeout(() => {
      setHistoricalCityReports([])
      setHistoricalIsSampled(false)

      fetchHistoricalCityReports(
        historicalQueryStartDate,
        historicalQueryEndDate,
        controller.signal,
      )
        .then(({ reports, sampled }) => {
          if (active) {
            setHistoricalCityReports(reports)
            setHistoricalIsSampled(sampled)
          }
        })
        .catch((error: unknown) => {
          if (active && !controller.signal.aborted) {
            setCityError(error instanceof Error ? error.message : 'Unable to load historical City reports.')
          }
        })
        .finally(() => {
          if (active) setCityLoading(false)
        })
    }, 250)

    return () => {
      active = false
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [cityStartDate, historicalQueryStartDate, historicalQueryEndDate])

  const summaryReports = useMemo(() => reports.filter((report) =>
    (typeFilter === 'all' || report.issue_type === typeFilter) &&
    visibleIssueTypes.includes(report.issue_type) &&
    (sourceFilter === 'all' || report.source === sourceFilter) &&
    isWithinDateRange(
      report,
      timelineDisplayMode === 'cumulative' ? timelineStartDate : activeTimelineDate,
      activeTimelineDate,
    ) &&
    (!isNearMeActive || !nearMeLocation || distanceInKilometers(nearMeLocation, report) <= NEARBY_RADIUS_KM),
  ), [reports, typeFilter, visibleIssueTypes, sourceFilter, timelineStartDate, activeTimelineDate, timelineDisplayMode, isNearMeActive, nearMeLocation])

  const filteredReports = useMemo(() => summaryReports.filter((report) =>
    statusFilter === 'all' ||
    (statusFilter === 'needs-attention'
      ? report.status === 'open' || report.status === 'in-progress'
      : report.status === statusFilter),
  ), [summaryReports, statusFilter])

  const myReports = useMemo(
    () => userReports.filter((report) => report.source === 'user').slice(0, 20),
    [userReports],
  )

  const selectedMyReport = useMemo(
    () => myReports.find((report) => report.id === selectedMyReportId) ?? null,
    [myReports, selectedMyReportId],
  )

  const openCount = summaryReports.filter((report) => report.status === 'open' || report.status === 'in-progress').length
  const resolvedCount = summaryReports.filter((report) => report.status === 'resolved').length
  const isLoading = initialCityLoading || reportsLoading

  async function confirmReport(report: Report) {
    if (report.source !== 'user') return
    if (!confirmerId) {
      setConfirmationErrors((current) => ({
        ...current,
        [report.id]: confirmationSetupError || 'Confirmation is unavailable because browser storage could not be accessed.',
      }))
      return
    }
    if (confirmedReportIds.has(report.id) || confirmingReportIds.has(report.id)) return

    setConfirmingReportIds((current) => new Set(current).add(report.id))
    setConfirmationErrors((current) => {
      const next = { ...current }
      delete next[report.id]
      return next
    })

    try {
      if (supabase) {
        const { error } = await supabase
          .from('report_confirmations')
          .insert({ report_id: report.id, confirmer_id: confirmerId })
        if (error && error.code !== '23505') {
          throw new Error(`Could not confirm this report: ${error.message}`)
        }
        if (!error) {
          setUserReports((current) => current.map((item) => item.id === report.id
            ? { ...item, confirmation_count: (item.confirmation_count ?? 0) + 1 }
            : item))
        }
      } else {
        const nextReports = userReports.map((item) => item.id === report.id
          ? { ...item, confirmation_count: (item.confirmation_count ?? 0) + 1 }
          : item)
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(nextReports))
        setUserReports(nextReports)
      }

      const nextConfirmedIds = new Set(confirmedReportIds).add(report.id)
      localStorage.setItem(LOCAL_CONFIRMATIONS_KEY, JSON.stringify([...nextConfirmedIds]))
      setConfirmedReportIds(nextConfirmedIds)
    } catch (error) {
      setConfirmationErrors((current) => ({
        ...current,
        [report.id]: error instanceof Error ? error.message : 'Unable to confirm this report.',
      }))
    } finally {
      setConfirmingReportIds((current) => {
        const next = new Set(current)
        next.delete(report.id)
        return next
      })
    }
  }

  function toggleStatusFilter(nextFilter: StatusFilter) {
    setStatusFilter((current) => current === nextFilter ? 'all' : nextFilter)
  }

  function changeTimelineStart(date: string) {
    if (!date) return
    const nextEndDate = date > timelineEndDate ? date : timelineEndDate
    setTimelineStartDate(date)
    setTimelineEndDate(nextEndDate)
    setSelectedTimelineDate((current) => current < date ? date : current > nextEndDate ? nextEndDate : current)
  }

  function changeTimelineEnd(date: string) {
    if (!date) return
    const nextStartDate = date < timelineStartDate ? date : timelineStartDate
    setTimelineStartDate(nextStartDate)
    setTimelineEndDate(date)
    setSelectedTimelineDate((current) => current < nextStartDate ? nextStartDate : current > date ? date : current)
  }

  async function searchAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const query = addressQuery.trim()
    if (!query) {
      setAddressError('Enter an address or place name.')
      return
    }

    setIsGeocoding(true)
    setAddressError('')

    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`)
      if (!response.ok) throw new Error('Address lookup failed.')
      const results = await response.json() as Array<{ lat?: string; lon?: string; display_name?: string }>
      const match = results[0]
      if (!match || !match.lat || !match.lon) {
        setAddressError('No matching address found on the map.')
        return
      }

      const coordinates = { latitude: Number(match.lat), longitude: Number(match.lon) }
      const formattedAddress = match.display_name || query
      setNearMeLocation(coordinates)
      setIsNearMeActive(true)
      setAddressError('')
      setAddressQuery(formattedAddress)
      setVisibleIssueTypes(issueTypes)
      setTypeFilter('all')
    } catch (error) {
      setAddressError(error instanceof Error ? error.message : 'Unable to find that address.')
    } finally {
      setIsGeocoding(false)
    }
  }

  function startPlacing() {
    const preferredLocation = draftLocation ?? null
    setIssueType('pothole')
    setDraftLocation(preferredLocation)
    setDescription((current) => {
      const trimmed = current.trim()
      if (trimmed && !current.startsWith('Found a ')) return current
      return buildAutoDescription('pothole', preferredLocation, addressQuery.trim() || null)
    })
    setFormError('')
    setDuplicateReport(null)
    setReportPanelOpen(false)
    setIsPlacing(true)
  }

  function cancelPlacing() {
    setDraftLocation(null)
    setIsPlacing(false)
    setReportPanelOpen(false)
    setFormError('')
    setDuplicateReport(null)
  }

  function openMyReports() {
    setMyReportsOpen((current) => !current)
  }

  function handleMyReportSelect(reportId: string) {
    const report = myReports.find((item) => item.id === reportId)
    if (!report) return

    setTypeFilter('all')
    setVisibleIssueTypes((current) => current.includes(report.issue_type) ? current : [...current, report.issue_type])
    setSourceFilter('all')
    setStatusFilter('all')
    const reportDate = report.created_at.slice(0, 10)
    setTimelineStartDate(reportDate)
    setTimelineEndDate(reportDate)
    setSelectedTimelineDate(reportDate)
    setTimelineDisplayMode('day')
    setIsNearMeActive(false)
    setSelectedMyReportId(reportId)
    setMyReportsOpen(false)
  }

  function deleteLocalReport(reportId: string) {
    try {
      const nextReports = userReports.filter((report) => report.id !== reportId)
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(nextReports))
      setUserReports(nextReports)
      setSelectedMyReportId((current) => current === reportId ? null : current)
      setReportPendingDeletion(null)
      setDeleteReportError('')
    } catch (error) {
      setDeleteReportError(error instanceof Error ? `Could not delete report: ${error.message}` : 'Could not delete report.')
    }
  }

  function handleReportPanelPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest('button, input, select, textarea, label')) return
    const panel = reportPanelRef.current
    if (!panel) return

    const bounds = panel.getBoundingClientRect()
    reportDragOffset.current = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    }
    event.preventDefault()
  }

  function useMyLocation() {
    void getCurrentPosition()
      .then(async (location) => {
        const locationLabel = await getLocationAddressLabel(location)
        setDeviceLocation(location)
        setIssueType('pothole')
        setDraftLocation(location)
        setAddressQuery(locationLabel)
        setDescription((current) => {
          const trimmed = current.trim()
          if (trimmed && !current.startsWith('Found a ')) return current
          return buildAutoDescription('pothole', location, locationLabel)
        })
        setIsPlacing(false)
        setReportPanelOpen(true)
        setFormError('')
        setDuplicateReport(null)
      })
      .catch((error: unknown) => setFormError(error instanceof Error ? error.message : 'Unable to get your location.'))
  }

  async function showProblemsNearMe() {
    if (isNearMeActive) {
      setIsNearMeActive(false)
      setNearMeError('')
      return
    }

    if (nearMeLocation) {
      setIsNearMeActive(true)
      setNearMeError('')
      return
    }

    setIsLocating(true)
    setNearMeError('')
    try {
      const location = await getCurrentPosition()
      setDeviceLocation(location)
      setNearMeLocation(location)
      setIsNearMeActive(true)
      if (!addressQuery.trim()) {
        setAddressQuery('Your location')
      }
    } catch (error) {
      setNearMeError(error instanceof Error ? error.message : 'Unable to get your location.')
    } finally {
      setIsLocating(false)
    }
  }

  async function getMyLocationForAddress() {
    setIsLocating(true)
    setNearMeError('')
    setAddressError('')
    try {
      const location = await getCurrentPosition()
      const locationLabel = await getLocationAddressLabel(location)
      setDeviceLocation(location)
      setNearMeLocation(location)
      setIsNearMeActive(true)
      setAddressQuery(locationLabel)
    } catch (error) {
      setNearMeError(error instanceof Error ? error.message : 'Unable to get your location.')
    } finally {
      setIsLocating(false)
    }
  }

  function toggleIssueType(issue: IssueType) {
    setVisibleIssueTypes((current) => {
      const nextVisible = current.includes(issue)
        ? current.filter((visibleType) => visibleType !== issue)
        : [...current, issue]

      if (typeFilter !== 'all' && nextVisible.length === 0) {
        setTypeFilter('all')
      }

      return nextVisible
    })
  }

  function checkAllIssueTypes() {
    setVisibleIssueTypes(issueTypes)
    setTypeFilter('all')
  }

  function uncheckAllIssueTypes() {
    setVisibleIssueTypes([])
  }

  async function submitReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await processReportSubmission(false)
  }

  async function processReportSubmission(skipDuplicateCheck: boolean) {
    if (!draftLocation) {
      setFormError('Click the map to choose where the issue is located.')
      return
    }
    const cleanDescription = description.trim()
    if (cleanDescription.length < 5) {
      setFormError('Add a description of at least 5 characters.')
      return
    }
    if (cleanDescription.length > 500) {
      setFormError('Keep the description under 500 characters.')
      return
    }

    const report: Report = {
      id: crypto.randomUUID(),
      ...draftLocation,
      issue_type: issueType,
      description: cleanDescription,
      severity,
      status: 'open',
      source: 'user',
      created_at: new Date().toISOString(),
      address: formatReportLocation(draftLocation, addressQuery.trim() || null),
      confirmation_count: 0,
    }

    if (!skipDuplicateCheck) {
      const nearbyOpenReport = reports
        .filter((candidate) => candidate.issue_type === issueType && candidate.status === 'open')
        .map((candidate) => ({
          report: candidate,
          distance: distanceInKilometers(draftLocation, candidate),
        }))
        .filter(({ distance }) => distance <= NEAR_DUPLICATE_RADIUS_KM)
        .sort((first, second) => first.distance - second.distance)[0]?.report

      if (nearbyOpenReport) {
        setDuplicateReport(nearbyOpenReport)
        setFormError('')
        return
      }
    }

    setIsSaving(true)
    setFormError('')
    setDuplicateReport(null)
    try {
      let savedReport = report
      if (supabase) {
        const { data, error } = await supabase
          .from('reports')
          .insert({
            id: report.id,
            issue_type: report.issue_type,
            description: report.description,
            severity: report.severity,
            latitude: report.latitude,
            longitude: report.longitude,
            status: report.status,
            source: report.source,
            created_at: report.created_at,
          })
          .select('id, issue_type, description, severity, latitude, longitude, status, source, created_at, external_id, confirmation_count')
          .single()
        if (error) throw new Error(`Could not save your report: ${error.message}`)
        savedReport = {
          ...report,
          id: data.id,
          created_at: data.created_at,
          external_id: data.external_id,
          confirmation_count: data.confirmation_count ?? 0,
        }
        setUserReports((current) => [savedReport, ...current])
      } else {
        const nextReports = [report, ...userReports]
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(nextReports))
        setUserReports(nextReports)
      }

      try {
        await submitReportToApi(savedReport)
      } catch (onlineError) {
        console.warn('Online report logging failed.', onlineError)
      }

      setDescription('')
      setDraftLocation(null)
      setIsPlacing(false)
      setReportPanelOpen(false)
      setReportsError('')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save your report.')
    } finally {
      setIsSaving(false)
    }
  }

  function submitAsNewReport() {
    void processReportSubmission(true)
  }

  function dismissDuplicateReport() {
    if (duplicateReport?.source === 'user') {
      void confirmReport(duplicateReport)
    }
    cancelPlacing()
  }

  function renderDuplicateWarning() {
    if (!duplicateReport || !draftLocation) return null

    const distance = distanceInKilometers(draftLocation, duplicateReport)
    return (
      <div className="duplicate-warning" role="alert">
        <p>Something similar was recently reported in this area, is this the same?</p>
        <span>{issueLabel(duplicateReport.issue_type)} · {distance < 1 ? `${Math.round(distance * 1000)} m` : `${distance.toFixed(1)} km`} away · {new Date(duplicateReport.created_at).toLocaleDateString()}</span>
        <div className="duplicate-actions">
          <button type="button" onClick={dismissDuplicateReport}>
            {duplicateReport.source === 'user' ? 'Yes, confirm this report' : "Yes, don't submit another"}
          </button>
          <button type="button" onClick={submitAsNewReport} disabled={isSaving}>No, submit a new report</button>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="StreetScope home">
          <span className="brand-name">Street<span>Scope</span></span>
          <span className="brand-divider" />
          <span className="brand-place">SACRAMENTO, CA</span>
        </a>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <section className="stats-grid" aria-label="Report statistics" aria-busy={isLoading}>
            <button type="button" className={`stat-card stat-total ${statusFilter === 'all' ? 'active' : ''}`} onClick={() => toggleStatusFilter('all')}>
              <span className="stat-label">ON THE MAP</span>
              <strong>{summaryReports.length.toLocaleString()}</strong>
              <span className="stat-caption">{isLoading ? 'updating…' : 'total reports'}</span>
            </button>
            <button type="button" className={`stat-card ${statusFilter === 'needs-attention' ? 'active' : ''}`} onClick={() => toggleStatusFilter('needs-attention')}>
              <span className="stat-label">NEEDS ATTENTION</span>
              <strong>{openCount.toLocaleString()}</strong>
              <span className="stat-caption">{isLoading ? 'updating…' : 'open issues'}</span>
            </button>
            <button type="button" className={`stat-card ${statusFilter === 'resolved' ? 'active' : ''}`} onClick={() => toggleStatusFilter('resolved')}>
              <span className="stat-label">TAKEN CARE OF</span>
              <strong>{resolvedCount.toLocaleString()}</strong>
              <span className="stat-caption">{isLoading ? 'updating…' : 'resolved'}</span>
            </button>
          </section>

          <section className="address-search-section">
            <div className="section-title-row">
              <h2><MapPin size={15} /> ADDRESS</h2>
              <button
                className="near-me-button address-location-button"
                type="button"
                onClick={() => void getMyLocationForAddress()}
                disabled={isLocating}
              >
                {isLocating ? <span className="button-spinner" /> : <LocateFixed size={14} />}
                {isLocating ? 'Finding your location…' : 'Get my location'}
              </button>
            </div>
            {nearMeError && <p className="inline-error near-me-error" role="alert"><AlertCircle size={14} /> {nearMeError}</p>}
            <form className="address-search-form" onSubmit={(event) => void searchAddress(event)}>
              <input
                type="text"
                value={addressQuery}
                onChange={(event) => setAddressQuery(event.target.value)}
                placeholder="Search for an address"
                aria-label="Search for an address on the map"
              />
              <button type="submit" disabled={isGeocoding}>
                {isGeocoding ? <span className="button-spinner" /> : <Search size={14} />}
              </button>
            </form>
            {addressError && <p className="inline-error address-error" role="alert"><AlertCircle size={14} /> {addressError}</p>}
          </section>

          <section className="filter-section">
            <div className="section-title-row">
              <h2><Filter size={15} /> FILTER THE MAP</h2>
            </div>
            <button
              className={`near-me-button ${isNearMeActive ? 'active' : ''}`}
              type="button"
              onClick={() => void showProblemsNearMe()}
              disabled={isLocating}
            >
              {isLocating ? <span className="button-spinner" /> : <LocateFixed size={15} />}
              {isLocating ? 'Finding your location…' : isNearMeActive ? 'Showing problems near me' : 'Problems near me'}
              {isNearMeActive && <span className="near-me-radius">5 KM · ON</span>}
            </button>
            {isNearMeActive && (
              <p className="near-me-summary">
                {filteredReports.length
                  ? `${filteredReports.length} matching ${filteredReports.length === 1 ? 'problem' : 'problems'} within 5 km.`
                  : 'No matching problems within 5 km. Try enabling more issue types.'}
              </p>
            )}
            <label className="field-label" htmlFor="type-filter">ISSUE TYPE</label>
            <div className="select-wrap">
              <select id="type-filter" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as IssueType | 'all')}>
                <option value="all">All issue types</option>
                {issueTypes.map((type) => <option value={type} key={type}>{issueLabel(type)}</option>)}
              </select>
              <ChevronDown size={15} />
            </div>
            <div className="issue-checklist" aria-label="Show issue types on the map">
              <div className="issue-checklist-header">
                <span className="field-label">SHOW ON MAP</span>
                <div className="issue-toggle-actions">
                  <button type="button" className="issue-toggle-button" onClick={checkAllIssueTypes}>Check all</button>
                  <button type="button" className="issue-toggle-button" onClick={uncheckAllIssueTypes}>Uncheck all</button>
                </div>
              </div>
              <div className="issue-checklist-items">
                {issueTypes.map((type) => (
                  <label className="issue-checkbox" key={type}>
                    <input
                      type="checkbox"
                      checked={visibleIssueTypes.includes(type)}
                      onChange={() => toggleIssueType(type)}
                    />
                    <span className="issue-checkbox-indicator" style={{ '--issue-color': issueColors[type] } as CSSProperties}>
                      {visibleIssueTypes.includes(type) && <span className="issue-checkbox-dot" style={{ backgroundColor: '#fff' }} />}
                    </span>
                    <span>{issueLabel(type)}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="filter-row">
              <div>
                <label className="field-label" htmlFor="source-filter">SOURCE</label>
                <div className="select-wrap">
                  <select id="source-filter" value={sourceFilter} onChange={(event) => {
                    setSourceFilter(event.target.value as SourceFilter)
                  }}>
                    <option value="all">All sources</option>
                    <option value="user">Community</option>
                    <option value="city-of-sacramento">City of Sacramento</option>
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
              <div>
                <label className="field-label" htmlFor="status-filter">STATUS</label>
                <div className="select-wrap">
                  <select id="status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                    <option value="all">Any status</option>
                    <option value="needs-attention">Needs attention</option>
                    <option value="open">Open</option>
                    <option value="in-progress">In progress</option>
                    <option value="resolved">Resolved</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
            </div>
            <section className="timeline-section" aria-label="Filter reports by date">
              <div className="timeline-heading">
                <span className="field-label">REPORT TIMELINE</span>
              </div>
              <div className="timeline-date-bounds">
                <label>
                  <span className="field-label">START</span>
                  <input
                    aria-label="Timeline start date"
                    type="date"
                    max={timelineEndDate}
                    value={timelineStartDate}
                    onChange={(event) => changeTimelineStart(event.target.value)}
                  />
                </label>
                <label>
                  <span className="field-label">END</span>
                  <input
                    aria-label="Timeline end date"
                    type="date"
                    min={timelineStartDate}
                    max={new Date().toISOString().slice(0, 10)}
                    value={timelineEndDate}
                    onChange={(event) => changeTimelineEnd(event.target.value)}
                  />
                </label>
              </div>
              <div className="timeline-selected-date" aria-live="polite">{formatTimelineDate(activeTimelineDate)}</div>
              <div className="timeline-range">
                <div className="timeline-track" />
                <input
                  aria-label="Select timeline day"
                  aria-valuetext={formatTimelineDate(activeTimelineDate)}
                  type="range"
                  min={0}
                  max={timelineDayCount}
                  value={selectedTimelineOffset}
                  disabled={timelineDayCount === 0}
                  onChange={(event) => setSelectedTimelineDate(addDaysToDate(timelineStartDate, Number(event.target.value)))}
                />
              </div>
              <div className="timeline-mode-toggle" role="group" aria-label="Timeline display mode">
                <button
                  type="button"
                  aria-pressed={timelineDisplayMode === 'day'}
                  onClick={() => setTimelineDisplayMode('day')}
                >
                  Show issues of the day
                </button>
                <button
                  type="button"
                  aria-pressed={timelineDisplayMode === 'cumulative'}
                  onClick={() => setTimelineDisplayMode('cumulative')}
                >
                  Show issues cumulatively
                </button>
              </div>
              <p className="timeline-caption">
                {timelineDisplayMode === 'cumulative'
                  ? 'Showing issues reported from the start date through the selected day.'
                  : 'Showing issues reported on the selected day.'}
              </p>
              {historicalIsSampled && (
                <p className="timeline-caption" role="status">
                  Showing up to {MAX_CUMULATIVE_REPORTS.toLocaleString()} reports sampled across the selected dates; counts reflect this sample.
                </p>
              )}
              {filteredReports.length > MAX_RENDERED_REPORT_MARKERS && (
                <p className="timeline-caption" role="status">
                  The map displays up to {MAX_RENDERED_REPORT_MARKERS.toLocaleString()} markers at a time.
                </p>
              )}
            </section>
          </section>

          {isPlacing && (
            <section className="report-form-section">
              <div className="section-title-row">
                <h2><MapPin size={15} /> NEW COMMUNITY REPORT</h2>
                <button className="icon-button" type="button" aria-label="Cancel report" onClick={cancelPlacing}><X size={16} /></button>
              </div>
              <p className="form-hint">{draftLocation ? 'Location pinned. Add a few details.' : 'Click anywhere on the map to drop a pin.'}</p>
              {draftLocation && (
                <div className="selected-location">
                  <MapPin size={14} />
                  <span>{draftLocation.latitude.toFixed(5)}, {draftLocation.longitude.toFixed(5)}</span>
                  <button type="button" onClick={useMyLocation}><LocateFixed size={14} /> Use my location</button>
                </div>
              )}
              {renderDuplicateWarning()}
              <form className="report-form" onSubmit={(event) => void submitReport(event)}>
                <label className="field-label" htmlFor="report-type">ISSUE TYPE</label>
                <div className="select-wrap">
                  <select id="report-type" value={issueType} onChange={(event) => {
                    setIssueType(event.target.value as IssueType)
                    setDuplicateReport(null)
                  }}>
                    {issueTypes.map((type) => <option value={type} key={type}>{issueLabel(type)}</option>)}
                  </select>
                  <ChevronDown size={15} />
                </div>
                <label className="field-label" htmlFor="report-description">WHAT DID YOU NOTICE?</label>
                <textarea
                  id="report-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  minLength={5}
                  maxLength={500}
                  placeholder="Share a helpful detail, like a nearby cross street."
                  rows={3}
                  required
                />
                <div className="form-bottom-row">
                  <label className="severity-field">
                    <span className="field-label">SEVERITY</span>
                    <span className="select-wrap">
                      <select value={severity} onChange={(event) => setSeverity(event.target.value as Severity)} aria-label="Severity">
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                      <ChevronDown size={15} />
                    </span>
                  </label>
                  <span className="character-count">{description.length}/500</span>
                </div>
                {formError && <p className="inline-error" role="alert"><AlertCircle size={14} /> {formError}</p>}
                <button className="submit-button" type="submit" disabled={isSaving}>
                  {isSaving ? <><span className="button-spinner" /> Saving report…</> : <><MapPin size={15} /> Add to the map <ArrowUpRight size={15} /></>}
                </button>
                {!supabase && <p className="storage-note">Saved in this browser. Add Supabase keys to share across devices.</p>}
              </form>
            </section>
          )}

          <div className="sidebar-footer">
            <div className="data-status">
              <span className={`status-pulse ${cityError ? 'error' : ''}`} />
              <span>{cityLoading ? 'Connecting to city data…' : cityError ? 'City data unavailable' : 'City 311 repair records'}</span>
              <a href="https://services5.arcgis.com/54falWtcpty3V47Z/arcgis/rest/services/311_Repairs_WFL1/FeatureServer" target="_blank" rel="noreferrer" aria-label="Open City of Sacramento data source"><ArrowUpRight size={13} /></a>
            </div>
            <p>The prototype aggregates public government infrastructure data and combines it with community-submitted reports.</p>
            {cityError && <p className="data-error" role="alert">{cityError}</p>}
            {reportsError && <p className="data-error" role="alert">{reportsError}</p>}
            {cityReports.length > 0 && <span className="last-updated"><Radio size={11} /> {cityReports.length} public repair records loaded</span>}
          </div>
        </aside>

        <section className="map-panel" aria-label="Sacramento infrastructure map">
          <GoogleMapSurface
            isPlacing={isPlacing}
            onMapSelect={async (latitude, longitude) => {
              const location = { latitude, longitude }
              setDraftLocation(location)
              setFormError('')
              setDuplicateReport(null)
              setAddressQuery(await getLocationAddressLabel(location))
              setReportPanelOpen(true)
              setIsPlacing(false)
            }}
            deviceLocation={deviceLocation}
            onLocationFound={(location) => {
              setDeviceLocation(location)
              setNearMeLocation(location)
              setAddressQuery('Your location')
            }}
            onLocationError={setNearMeError}
            selectedReport={selectedMyReport}
            isNearMeActive={isNearMeActive}
            nearMeLocation={nearMeLocation}
            locationLabel={addressQuery || 'Your location'}
            reports={filteredReports}
            draftLocation={draftLocation}
            issueType={issueType}
            confirmedReportIds={confirmedReportIds}
            confirmingReportIds={confirmingReportIds}
            confirmationErrors={confirmationErrors}
            confirmationSetupError={confirmationSetupError}
            onConfirm={(report) => void confirmReport(report)}
          />
          <div className="map-fab-stack">
            <button className={`top-report-button map-report-button ${isPlacing ? 'active' : ''}`} onClick={isPlacing ? cancelPlacing : startPlacing} type="button" aria-label={isPlacing ? 'Cancel report' : 'Report an issue'}>
              {isPlacing ? <X size={15} /> : <Plus size={16} />}
              {isPlacing ? 'Cancel report' : 'Report an issue'}
            </button>
            <button
              className="top-report-button map-report-button"
              type="button"
              onClick={openMyReports}
              aria-expanded={myReportsOpen}
              aria-controls="my-reports-panel"
            >
              <MapPin size={15} />
              My Reports
            </button>
          </div>
          {myReportsOpen && (
            <section id="my-reports-panel" className="my-reports-panel" aria-label="My reports">
              <div className="my-reports-header">
                <h2>MY REPORTS</h2>
                <button type="button" aria-label="Close My Reports" onClick={() => setMyReportsOpen(false)}><X size={15} /></button>
              </div>
              {reportsLoading ? (
                <p className="my-reports-empty">Loading your reports…</p>
              ) : reportsError ? (
                <p className="my-reports-empty" role="alert">{reportsError}</p>
              ) : myReports.length === 0 ? (
                <p className="my-reports-empty">No community reports yet. Use “Report an issue” to add your first.</p>
              ) : (
                <ul className="my-reports-list">
                  {myReports.map((report) => (
                    <li key={report.id}>
                      <div className="my-report-entry">
                        <button type="button" className="my-report-item" onClick={() => handleMyReportSelect(report.id)}>
                          <span className="my-report-item-heading">
                            <strong>{issueLabel(report.issue_type)}</strong>
                            <small className={`my-report-status ${report.status === 'resolved' ? 'resolved' : 'open'}`}>{statusLabel(report.status)}</small>
                          </span>
                          <span className="my-report-item-description">{report.description}</span>
                          <span className="my-report-item-date">{new Date(report.created_at).toLocaleDateString()}</span>
                          <span className={`my-report-confirmation ${(report.confirmation_count ?? 0) >= CONFIRMATION_THRESHOLD ? 'confirmed' : 'unconfirmed'}`}>
                            {(report.confirmation_count ?? 0) >= CONFIRMATION_THRESHOLD
                              ? `Confirmed by ${report.confirmation_count} people`
                              : 'Unconfirmed'}
                          </span>
                        </button>
                        {!supabase && (
                          reportPendingDeletion === report.id ? (
                            <div className="delete-report-confirm" role="alertdialog" aria-label="Confirm report deletion">
                              <p>Warning! This will permanently delete your report. Are you sure?</p>
                              {deleteReportError && <p className="inline-error" role="alert">{deleteReportError}</p>}
                              <div>
                                <button type="button" onClick={() => deleteLocalReport(report.id)}>Yes</button>
                                <button type="button" onClick={() => {
                                  setReportPendingDeletion(null)
                                  setDeleteReportError('')
                                }}>No</button>
                              </div>
                            </div>
                          ) : (
                            <button
                              className="delete-report-button"
                              type="button"
                              onClick={() => {
                                setReportPendingDeletion(report.id)
                                setDeleteReportError('')
                              }}
                            >
                              Delete report
                            </button>
                          )
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {supabase && <p className="my-reports-delete-note">Deleting shared reports is unavailable because report ownership is not set up.</p>}
            </section>
          )}
          {reportPanelOpen && (
            <div ref={reportPanelRef} className="report-panel" style={{ left: reportPanelPosition.x, top: reportPanelPosition.y }}>
              <div className="report-panel-header" onPointerDown={handleReportPanelPointerDown}>
                <div className="report-panel-grip" aria-hidden="true" />
                <span>NEW COMMUNITY REPORT</span>
                <button className="icon-button" type="button" aria-label="Cancel report" onClick={cancelPlacing}><X size={16} /></button>
              </div>
              <div className="report-panel-body">
                <p className="form-hint">{draftLocation ? 'Location pinned. Add a few details.' : 'Click anywhere on the map to drop a pin.'}</p>
                {draftLocation && (
                  <div className="selected-location">
                    <MapPin size={14} />
                    <span>{addressQuery.trim() || `${draftLocation.latitude.toFixed(5)}, ${draftLocation.longitude.toFixed(5)}`}</span>
                    <button type="button" onClick={useMyLocation}><LocateFixed size={14} /> Use my location</button>
                  </div>
                )}
                {renderDuplicateWarning()}
                <form className="report-form" onSubmit={(event) => void submitReport(event)}>
                  <label className="field-label" htmlFor="report-type">ISSUE TYPE</label>
                  <div className="select-wrap">
                    <select id="report-type" value={issueType} onChange={(event) => {
                      setIssueType(event.target.value as IssueType)
                      setDuplicateReport(null)
                    }}>
                      {issueTypes.map((type) => <option value={type} key={type}>{issueLabel(type)}</option>)}
                    </select>
                    <ChevronDown size={15} />
                  </div>
                  <label className="field-label" htmlFor="report-description">WHAT DID YOU NOTICE?</label>
                  <textarea
                    id="report-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    minLength={5}
                    maxLength={500}
                    placeholder="Share a helpful detail, like a nearby cross street."
                    rows={3}
                    required
                  />
                  <div className="form-bottom-row">
                    <label className="severity-field">
                      <span className="field-label">SEVERITY</span>
                      <span className="select-wrap">
                        <select value={severity} onChange={(event) => setSeverity(event.target.value as Severity)} aria-label="Severity">
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                        </select>
                        <ChevronDown size={15} />
                      </span>
                    </label>
                    <span className="character-count">{description.length}/500</span>
                  </div>
                  {formError && <p className="inline-error" role="alert"><AlertCircle size={14} /> {formError}</p>}
                  <button className="submit-button" type="submit" disabled={isSaving}>
                    {isSaving ? <><span className="button-spinner" /> Saving report…</> : <><MapPin size={15} /> Add to the map <ArrowUpRight size={15} /></>}
                  </button>
                  {!supabase && <p className="storage-note">Saved in this browser. Add Supabase keys to share across devices.</p>}
                </form>
              </div>
            </div>
          )}
          <div className="map-overlay map-overlay-top"><span className="map-area-dot" /> SACRAMENTO <span className="map-overlay-divider">/</span> CENTRAL CITY</div>
          {isPlacing && !draftLocation && <div className="map-instruction"><ArrowDown size={15} /> Click the map to place your report</div>}
          {isPlacing && draftLocation && !reportPanelOpen && (
            <div className="map-instruction"><MapPin size={15} /> Location selected — complete the report below</div>
          )}
          {cityLoading && <div className="map-loading"><span className="button-spinner" /> Loading public records</div>}
          {filteredReports.length === 0 && !cityError && (cityLoading || isLoading) && (
            <div className="empty-map" role="status"><span className="button-spinner" /><strong>Loading in progress</strong></div>
          )}
          {filteredReports.length === 0 && !cityLoading && !isLoading && !cityError && (
            <div className="empty-map"><MapPin size={18} /><strong>Nothing to show here</strong><span>Try adjusting your filters or add a report.</span></div>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
