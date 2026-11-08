import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, PointerEvent as ReactPointerEvent } from 'react'
import { MapContainer, TileLayer, CircleMarker, Marker, Popup, useMap, useMapEvents } from 'react-leaflet'
import { divIcon, latLngBounds } from 'leaflet'
import { createClient } from '@supabase/supabase-js'
import { AlertCircle, ArrowDown, ArrowUpRight, ChevronDown, Crosshair, Filter, LocateFixed, MapPin, Plus, Radio, Search, X } from 'lucide-react'
import { appConfig } from './config'

type IssueType = 'pothole' | 'streetlight' | 'construction' | 'sidewalk'
type Severity = 'low' | 'medium' | 'high'
type ReportStatus = 'open' | 'in-progress' | 'resolved'
type ReportSource = 'user' | 'city-of-sacramento'
type SourceFilter = 'all' | ReportSource
type StatusFilter = 'all' | ReportStatus | 'needs-attention'
interface Coordinates {
  latitude: number
  longitude: number
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
const LOCAL_STORAGE_KEY = 'sacramento-infrastructure-reports'
const LOCAL_CONFIRMATIONS_KEY = 'sacramento-infrastructure-confirmations'
const CONFIRMER_ID_KEY = 'sacramento-infrastructure-confirmer-id'
const CONFIRMATION_THRESHOLD = 3
const NEARBY_RADIUS_KM = 5
const NEAR_DUPLICATE_RADIUS_KM = 1
const DEFAULT_TIMELINE_DAYS = 30
const DEFAULT_STATUS_FILTER: StatusFilter = 'needs-attention'
const issueTypes: IssueType[] = ['pothole', 'streetlight', 'construction', 'sidewalk']
const issueColors: Record<IssueType, string> = {
  pothole: '#ef8257',
  streetlight: '#e5ad4e',
  construction: '#6187d9',
  sidewalk: '#4ca98b',
}

// Exact City of Sacramento 311 CategoryName values we show, mapped to our issue types.
// This is an allowlist: it drives both the ArcGIS `where` clause (so nothing else is
// downloaded) and the client-side mapping. Keyword matching is deliberately avoided —
// e.g. "Homeless Encampment Blocking Sidewalk" must never be classified as a sidewalk issue.
// The 311 layer has no dedicated construction category, so "construction" collects the
// remaining street/right-of-way work that affects people walking and biking.
const CITY_CATEGORY_ISSUE_TYPES: Record<string, IssueType> = {
  'Streets Pothole': 'pothole',
  'Streets Street Maintenance': 'pothole',
  'Streets Street Lighting': 'streetlight',
  'Streets Relamp': 'streetlight',
  'Streets Sidewalk': 'sidewalk',
  'Streets Curb/Gutter': 'sidewalk',
  'Streets General': 'construction',
  'Streets Streetscapes': 'construction',
  'Streets Signs and Markings': 'construction',
  'Streets Traffic Signals': 'construction',
  'Streets Traffic Investigation': 'construction',
  'Streets Bikeway Issues': 'construction',
  'Streets Bike Rack Issues': 'construction',
  'Streets Alley Gate': 'construction',
}
const CITY_CATEGORY_WHERE = `CategoryName IN (${Object.keys(CITY_CATEGORY_ISSUE_TYPES)
  .map((name) => `'${name.replace(/'/g, "''")}'`)
  .join(', ')})`

function isIssueType(value: unknown): value is IssueType {
  return typeof value === 'string' && (issueTypes as string[]).includes(value)
}

const supabaseUrl = appConfig.supabaseUrl
const supabaseAnonKey = appConfig.supabaseAnonKey
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null
const cartoBasemapKey = appConfig.cartoBasemapKey
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
  }[issueType]
}

function statusLabel(status: ReportStatus | 'needs-attention') {
  return {
    open: 'Open',
    'in-progress': 'In-progress',
    resolved: 'Resolved',
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

function getDefaultTimelineStartDate() {
  return new Date(Date.now() - DEFAULT_TIMELINE_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function createTimelineDates(reports: Report[], cityStartDate: string | null) {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const timestamps = reports
    .map((report) => Date.parse(report.created_at))
    .filter(Number.isFinite)
  const reportStartDate = timestamps.length > 0
    ? new Date(Math.min(...timestamps)).toISOString().slice(0, 10)
    : null
  const firstDate = [cityStartDate, reportStartDate].filter((date): date is string => date !== null).sort()[0]
    || new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const earliest = new Date(`${firstDate}T00:00:00.000Z`)
  const dates: string[] = [firstDate]

  for (let year = earliest.getUTCFullYear(), month = earliest.getUTCMonth(); ; ) {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    for (const day of [1, 15, lastDay]) {
      const date = new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10)
      if (date <= today && !dates.includes(date)) dates.push(date)
    }

    if (year === now.getUTCFullYear() && month === now.getUTCMonth()) break
    month += 1
    if (month > 11) {
      month = 0
      year += 1
    }
  }

  if (!dates.includes(today)) dates.push(today)
  // Add the default start as its own stop so the initial range is exactly the last
  // DEFAULT_TIMELINE_DAYS days instead of snapping back to the previous 1st/15th.
  const defaultStartDate = getDefaultTimelineStartDate()
  if (defaultStartDate > firstDate && !dates.includes(defaultStartDate)) dates.push(defaultStartDate)
  return dates.sort()
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

function normalizeCityIssueType(categoryName: string): IssueType | null {
  return Object.hasOwn(CITY_CATEGORY_ISSUE_TYPES, categoryName) ? CITY_CATEGORY_ISSUE_TYPES[categoryName] : null
}

function normalizeCityStatus(status: string | null | undefined): ReportStatus {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'closed') return 'resolved'
  if (normalized === 'in progress' || normalized === 'in-progress') return 'in-progress'
  return 'open'
}

async function fetchCityLayer(layer: number, signal: AbortSignal): Promise<Report[]> {
  const query = new URLSearchParams({
    where: CITY_CATEGORY_WHERE,
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
    const issueType = normalizeCityIssueType(categoryName)
    if (!issueType) return []

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
    where: CITY_CATEGORY_WHERE,
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

async function fetchHistoricalCityReports(startDate: string, endDate: string, signal: AbortSignal): Promise<Report[]> {
  const endExclusive = new Date(Date.parse(`${endDate}T00:00:00.000Z`) + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
  const where = `DateCreated >= TIMESTAMP '${startDate} 00:00:00' AND DateCreated < TIMESTAMP '${endExclusive} 00:00:00' AND (PublicStatus IS NULL OR UPPER(PublicStatus) <> 'CLOSED') AND ${CITY_CATEGORY_WHERE}`
  const reports: Report[] = []
  let resultOffset = 0

  while (true) {
    const query = new URLSearchParams({
      where,
      outFields: 'OBJECTID,CategoryName,CategoryLevel1,CategoryLevel2,PublicStatus,DateCreated,DateUpdated,Address,CrossStreet,Neighborhood',
      returnGeometry: 'true',
      outSR: '4326',
      geometryPrecision: '5',
      resultRecordCount: String(CITY_PAGE_SIZE),
      resultOffset: String(resultOffset),
      orderByFields: 'DateCreated ASC, OBJECTID ASC',
      f: 'geojson',
    })
    const response = await fetch(`${CITY_LAYER_URL}/0/query?${query}`, { signal })
    if (!response.ok) throw new Error(`Historical City data request failed (${response.status}).`)

    const collection = await response.json() as ArcGisFeatureCollection
    if (collection.error) throw new Error(collection.error.message || 'Historical City data could not be loaded.')
    const features = collection.features || []
    reports.push(...mapCityFeatures(collection, 0))
    if (features.length === 0 || (features.length < CITY_PAGE_SIZE && !collection.exceededTransferLimit)) break
    resultOffset += features.length
  }

  return reports
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
      cached.reports.every((report) => report.source === 'city-of-sacramento' && isIssueType(report.issue_type))
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

function MapClickHandler({ enabled, onSelect }: { enabled: boolean; onSelect: (latitude: number, longitude: number) => void }) {
  useMapEvents({
    click(event) {
      if (enabled) onSelect(event.latlng.lat, event.latlng.lng)
    },
  })
  return null
}

function MapSizeInvalidator() {
  const map = useMap()

  useEffect(() => {
    let frame = 0
    const invalidateSize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => map.invalidateSize({ pan: false }))
    }

    invalidateSize()
    const container = map.getContainer()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(invalidateSize)
    observer?.observe(container)
    window.addEventListener('resize', invalidateSize)

    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', invalidateSize)
    }
  }, [map])

  return null
}

function MapControls({
  location,
  onLocationFound,
  onLocationError,
}: {
  location: Coordinates | null
  onLocationFound: (location: Coordinates) => void
  onLocationError: (message: string) => void
}) {
  const map = useMap()
  const [zoom, setZoom] = useState(map.getZoom())
  const [isLocating, setIsLocating] = useState(false)

  useEffect(() => {
    const updateZoom = () => setZoom(map.getZoom())
    map.on('zoomend', updateZoom)
    return () => {
      map.off('zoomend', updateZoom)
    }
  }, [map])

  async function recenterOnMyLocation() {
    onLocationError('')
    if (location) {
      map.setView([location.latitude, location.longitude], 15, { animate: false })
      return
    }

    setIsLocating(true)
    try {
      const currentLocation = await getCurrentPosition()
      onLocationFound(currentLocation)
      map.setView([currentLocation.latitude, currentLocation.longitude], 15, { animate: false })
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
        onClick={() => map.zoomIn()}
        disabled={zoom >= map.getMaxZoom()}
      >
        +
      </button>
      <button
        className="map-control map-zoom-control"
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => map.zoomOut()}
        disabled={zoom <= map.getMinZoom()}
      >
        -
      </button>
    </div>
  )
}

function MyReportsMapController({
  report,
}: {
  report: Report | null
}) {
  const map = useMap()

  useEffect(() => {
    if (!report) return
    map.flyTo([report.latitude, report.longitude], 15, { duration: 0.8 })
  }, [map, report])

  return null
}

function NearbyMapController({
  active,
  location,
  reports,
}: {
  active: boolean
  location: Coordinates | null
  reports: Report[]
}) {
  const map = useMap()
  const lastFitTarget = useRef<string | null>(null)

  useEffect(() => {
    if (!active || !location) {
      lastFitTarget.current = null
      return
    }

    const fitTarget = `${location.latitude},${location.longitude}`
    if (lastFitTarget.current === fitTarget) return
    lastFitTarget.current = fitTarget

    if (reports.length > 0) {
      const bounds = latLngBounds([
        [location.latitude, location.longitude],
        ...reports.map((report) => [report.latitude, report.longitude] as [number, number]),
      ])
      map.fitBounds(bounds.pad(0.18), { maxZoom: 15, animate: false })
    } else {
      map.setView([location.latitude, location.longitude], 15, { animate: false })
    }
  }, [active, location, map, reports])

  return null
}

function ReportMarker({
  report,
  hasConfirmed,
  isConfirming,
  confirmationError,
  onConfirm,
}: {
  report: Report
  hasConfirmed: boolean
  isConfirming: boolean
  confirmationError?: string
  onConfirm: () => void
}) {
  const color = issueColors[report.issue_type]
  const confirmationCount = report.confirmation_count ?? 0
  const isConfirmed = confirmationCount >= CONFIRMATION_THRESHOLD
  const locationText = reportLocationLabel(report)
  const reportDate = new Date(report.created_at).toLocaleDateString()
  const reportTime = new Date(report.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    <CircleMarker
      center={[report.latitude, report.longitude]}
      radius={report.source === 'user' ? 8 : 6}
      pathOptions={{ color, fillColor: color, fillOpacity: 0.86, weight: 2 }}
    >
      <Popup>
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
            <span>Found at {locationText}</span>
            <div className="popup-meta-row">
              <span className="popup-meta-source">{sourceLabel(report.source)}</span>
              <span className="popup-meta-date">{reportDate}</span>
            </div>
          </div>
        </div>
      </Popup>
    </CircleMarker>
  )
}

function UserLocationMarker({ location, label }: { location: Coordinates; label: string }) {
  const userIcon = divIcon({
    className: 'user-location-marker',
    html: '<span class="user-location-marker-core"></span>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -12],
  })

  return (
    <Marker position={[location.latitude, location.longitude]} icon={userIcon}>
      <Popup>
        <div className="popup-content">
          <div className="popup-topline">
            <span className="popup-dot" style={{ backgroundColor: '#567052' }} />
            <strong>{label || 'Your location'}</strong>
          </div>
        </div>
      </Popup>
    </Marker>
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
  const [reportsLoading, setReportsLoading] = useState(true)
  const [cityError, setCityError] = useState('')
  const [reportsError, setReportsError] = useState('')
  const [typeFilter, setTypeFilter] = useState<IssueType | 'all'>('all')
  const [visibleIssueTypes, setVisibleIssueTypes] = useState<IssueType[]>(issueTypes)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(DEFAULT_STATUS_FILTER)
  const [timelineRange, setTimelineRange] = useState<{ start: number; end: number } | null>(null)
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
        setTimelineRange(null)
      })
      .catch((error: unknown) => {
        if (active) setCityError(error instanceof Error ? error.message : 'Unable to load City of Sacramento data.')
      })
      .finally(() => {
        if (active) setCityLoading(false)
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
            .in('issue_type', issueTypes)
            .order('created_at', { ascending: false })
            .limit(1000)
          if (error) throw new Error(`Could not load saved reports: ${error.message}`)
          if (active) {
            setUserReports((data || []).filter((row) => isIssueType(row.issue_type)).map((row) => ({
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
          if (active) setUserReports(savedReports.filter((report) => isIssueType(report.issue_type)).map((report) => ({
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
  const timelineDates = useMemo(() => createTimelineDates(userReports, cityStartDate), [userReports, cityStartDate])
  const timelineEndIndex = timelineDates.length - 1
  const defaultTimelineStartDate = getDefaultTimelineStartDate()
  let defaultTimelineStartIndex = 0
  for (let index = 0; index < timelineDates.length; index += 1) {
    if (timelineDates[index] > defaultTimelineStartDate) break
    defaultTimelineStartIndex = index
  }
  const timelineStartIndex = timelineRange
    ? Math.min(timelineRange.start, timelineEndIndex)
    : defaultTimelineStartIndex
  const timelineSelectedEndIndex = timelineRange
    ? Math.max(timelineStartIndex, Math.min(timelineRange.end, timelineEndIndex))
    : timelineEndIndex
  const timelineStartDate = timelineDates[timelineStartIndex]
  const timelineEndDate = timelineDates[timelineSelectedEndIndex]

  useEffect(() => {
    if (!cityStartDate || !timelineStartDate || !timelineEndDate) return

    let active = true
    const controller = new AbortController()
    setCityLoading(true)
    setCityError('')
    setHistoricalCityReports([])

    fetchHistoricalCityReports(timelineStartDate, timelineEndDate, controller.signal)
      .then((reports) => {
        if (active) setHistoricalCityReports(reports)
      })
      .catch((error: unknown) => {
        if (active && !controller.signal.aborted) {
          setCityError(error instanceof Error ? error.message : 'Unable to load historical City reports.')
        }
      })
      .finally(() => {
        if (active) setCityLoading(false)
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [cityStartDate, timelineStartDate, timelineEndDate])

  const summaryReports = useMemo(() => reports.filter((report) =>
    (typeFilter === 'all' || report.issue_type === typeFilter) &&
    visibleIssueTypes.includes(report.issue_type) &&
    (sourceFilter === 'all' || report.source === sourceFilter) &&
    isWithinDateRange(report, timelineStartDate, timelineEndDate) &&
    (!isNearMeActive || !nearMeLocation || distanceInKilometers(nearMeLocation, report) <= NEARBY_RADIUS_KM),
  ), [reports, typeFilter, visibleIssueTypes, sourceFilter, timelineStartDate, timelineEndDate, isNearMeActive, nearMeLocation])

  const filteredReports = useMemo(() => summaryReports.filter((report) =>
    (statusFilter === 'resolved'
      ? report.status === 'resolved'
      : (report.status !== 'resolved' || (statusFilter === 'all' && report.id === selectedMyReportId)) &&
        (statusFilter === 'all' || statusFilter === 'needs-attention' || report.status === statusFilter)),
  ), [summaryReports, statusFilter, selectedMyReportId])

  const myReports = useMemo(
    () => userReports.filter((report) => report.source === 'user').slice(0, 20),
    [userReports],
  )

  const selectedMyReport = useMemo(
    () => myReports.find((report) => report.id === selectedMyReportId) ?? null,
    [myReports, selectedMyReportId],
  )

  // Single source for the "ON THE MAP" stat and the sidebar footer so they always agree.
  const onTheMapCount = summaryReports.length
  const openCount = summaryReports.filter((report) => report.status !== 'resolved').length
  const resolvedCount = summaryReports.length - openCount
  const isLoading = cityLoading || reportsLoading

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
    let start = 0
    let end = timelineEndIndex
    for (let index = 0; index < timelineDates.length; index += 1) {
      if (timelineDates[index] <= reportDate) start = index
      if (timelineDates[index] >= reportDate) {
        end = index
        break
      }
    }
    setTimelineRange({ start, end })
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
          <section className="stats-grid" aria-label="Report statistics">
            <button type="button" className={`stat-card stat-total ${statusFilter === 'all' ? 'active' : ''}`} onClick={() => toggleStatusFilter('all')}>
              <span className="stat-label">ON THE MAP</span>
              <strong>{isLoading ? '—' : onTheMapCount.toLocaleString()}</strong>
              <span className="stat-caption">total reports</span>
            </button>
            <button type="button" className={`stat-card ${statusFilter === 'needs-attention' ? 'active' : ''}`} onClick={() => toggleStatusFilter('needs-attention')}>
              <span className="stat-label">NEEDS ATTENTION</span>
              <strong>{isLoading ? '—' : openCount.toLocaleString()}</strong>
              <span className="stat-caption">open issues</span>
            </button>
            <button type="button" className={`stat-card ${statusFilter === 'resolved' ? 'active' : ''}`} onClick={() => toggleStatusFilter('resolved')}>
              <span className="stat-label">TAKEN CARE OF</span>
              <strong>{isLoading ? '—' : resolvedCount.toLocaleString()}</strong>
              <span className="stat-caption">resolved</span>
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
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
            </div>
            <section className="timeline-section" aria-label="Filter currently unresolved reports by date">
              <div className="timeline-heading">
                <span className="field-label">NEEDS ATTENTION TIMELINE</span>
                <span className="timeline-step-note">1st · 15th · month end</span>
              </div>
              <div className="timeline-dates" aria-live="polite">
                <span><small>START</small>{formatTimelineDate(timelineStartDate)}</span>
                <span><small>END</small>{formatTimelineDate(timelineEndDate)}</span>
              </div>
              <div className="timeline-range">
                <div className="timeline-track" />
                <div
                  className="timeline-track-selected"
                  style={{
                    left: `${timelineEndIndex ? timelineStartIndex / timelineEndIndex * 100 : 0}%`,
                    right: `${timelineEndIndex ? (timelineEndIndex - timelineSelectedEndIndex) / timelineEndIndex * 100 : 0}%`,
                  }}
                />
                <input
                  aria-label="Start date"
                  aria-valuetext={formatTimelineDate(timelineStartDate)}
                  type="range"
                  min={0}
                  max={timelineEndIndex}
                  value={timelineStartIndex}
                  disabled={!cityStartDate || timelineEndIndex === 0}
                  onChange={(event) => setTimelineRange({
                    start: Math.min(Number(event.target.value), timelineSelectedEndIndex),
                    end: timelineSelectedEndIndex,
                  })}
                />
                <input
                  aria-label="End date"
                  aria-valuetext={formatTimelineDate(timelineEndDate)}
                  type="range"
                  min={0}
                  max={timelineEndIndex}
                  value={timelineSelectedEndIndex}
                  disabled={!cityStartDate || timelineEndIndex === 0}
                  onChange={(event) => setTimelineRange({
                    start: timelineStartIndex,
                    end: Math.max(Number(event.target.value), timelineStartIndex),
                  })}
                />
              </div>
              <p className="timeline-caption">Currently unresolved issues created in this range. Drag the handles to explore the timeline.</p>
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
            {!isLoading && <span className="last-updated"><Radio size={11} /> {onTheMapCount.toLocaleString()} {onTheMapCount === 1 ? 'report' : 'reports'} on the map</span>}
          </div>
        </aside>

        <section className="map-panel" aria-label="Sacramento infrastructure map">
          <MapContainer
            center={[38.5816, -121.4944]}
            zoom={13}
            minZoom={10}
            maxZoom={18}
            preferCanvas
            scrollWheelZoom
            className={isPlacing ? 'leaflet-map placing' : 'leaflet-map'}
            zoomControl={false}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; Tiles &copy; <a href="https://carto.com/attributions">CARTO</a>'
              url={cartoBasemapKey
                ? `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${encodeURIComponent(cartoBasemapKey)}`
                : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'}
              subdomains={cartoBasemapKey ? 'abcd' : 'abc'}
            />
            <MapSizeInvalidator />
            <MapClickHandler enabled={isPlacing} onSelect={async (latitude, longitude) => {
              const location = { latitude, longitude }
              setDraftLocation(location)
              setFormError('')
              setDuplicateReport(null)
              setAddressQuery(await getLocationAddressLabel(location))
              setReportPanelOpen(true)
              setIsPlacing(false)
            }} />
            <MapControls
              location={deviceLocation}
              onLocationFound={(location) => {
                setDeviceLocation(location)
                setNearMeLocation(location)
                setAddressQuery('Your location')
              }}
              onLocationError={setNearMeError}
            />
            <MyReportsMapController report={selectedMyReport} />
            <NearbyMapController active={isNearMeActive} location={nearMeLocation} reports={filteredReports} />
            {nearMeLocation && (
              <>
                <CircleMarker
                  center={[nearMeLocation.latitude, nearMeLocation.longitude]}
                  radius={16}
                  pathOptions={{ color: '#567052', fillColor: '#ffffff', fillOpacity: 0.92, weight: 3 }}
                />
                <UserLocationMarker location={nearMeLocation} label={addressQuery || 'Your location'} />
              </>
            )}
            {filteredReports.map((report) => (
              <ReportMarker
                key={report.id}
                report={report}
                hasConfirmed={confirmedReportIds.has(report.id)}
                isConfirming={confirmingReportIds.has(report.id)}
                confirmationError={confirmationErrors[report.id] || confirmationSetupError}
                onConfirm={() => void confirmReport(report)}
              />
            ))}
            {draftLocation && (
              <CircleMarker
                center={[draftLocation.latitude, draftLocation.longitude]}
                radius={11}
                pathOptions={{ color: '#282b26', fillColor: issueColors[issueType], fillOpacity: 0.5, weight: 3, dashArray: '4 5' }}
              />
            )}
          </MapContainer>
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
          {filteredReports.length === 0 && !isLoading && !cityError && (
            <div className="empty-map"><MapPin size={18} /><strong>Nothing to show here</strong><span>Try adjusting your filters or add a report.</span></div>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
