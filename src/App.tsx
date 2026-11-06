import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { MapContainer, TileLayer, CircleMarker, Popup, useMap, useMapEvents } from 'react-leaflet'
import { latLngBounds } from 'leaflet'
import { createClient } from '@supabase/supabase-js'
import { Activity, AlertCircle, ArrowDown, ArrowUpRight, Check, ChevronDown, CircleDot, Crosshair, Filter, LocateFixed, MapPin, Plus, Radio, X } from 'lucide-react'

type IssueType = 'pothole' | 'streetlight' | 'construction' | 'sidewalk'
type Severity = 'low' | 'medium' | 'high'
type ReportStatus = 'open' | 'in-progress' | 'resolved'
type ReportSource = 'user' | 'city-of-sacramento'
type SourceFilter = 'all' | ReportSource
type StatusFilter = 'all' | ReportStatus
type DateFilter = 'all' | 'last-90-days' | 'custom'
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
  external_id?: string | null
}

interface ArcGisFeatureCollection {
  features?: Array<{
    id?: string | number
    geometry?: { type: string; coordinates: number[] | number[][] }
    properties?: Record<string, unknown>
  }>
  error?: { message?: string }
}

const CITY_LAYER_URL = 'https://services5.arcgis.com/54falWtcpty3V47Z/arcgis/rest/services/311_Repairs_WFL1/FeatureServer'
const LOCAL_STORAGE_KEY = 'sacramento-infrastructure-reports'
const NEARBY_RADIUS_KM = 5
const LAST_90_DAYS_MS = 90 * 24 * 60 * 60 * 1000
const issueTypes: IssueType[] = ['pothole', 'streetlight', 'construction', 'sidewalk']
const issueColors: Record<IssueType, string> = {
  pothole: '#ef8257',
  streetlight: '#e5ad4e',
  construction: '#6187d9',
  sidewalk: '#4ca98b',
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null
const cartoBasemapKey = import.meta.env.VITE_CARTO_BASEMAP_KEY?.trim()
let locationRequest: Promise<Coordinates> | null = null

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

function statusLabel(status: ReportStatus) {
  return {
    open: 'Open',
    'in-progress': 'In progress',
    resolved: 'Resolved',
  }[status]
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

function customRangeError(startDate: string, endDate: string) {
  if (!startDate && !endDate) return 'Choose a start date, an end date, or both.'
  if (startDate && endDate && startDate > endDate) return 'The start date must be on or before the end date.'
  return ''
}

function isWithinCustomDateRange(report: Report, startDate: string, endDate: string) {
  const reportTime = Date.parse(report.created_at)
  if (!Number.isFinite(reportTime)) return false

  const rangeStart = startDate ? new Date(`${startDate}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY
  const rangeEnd = endDate
    ? new Date(`${endDate}T00:00:00`).getTime() + 24 * 60 * 60 * 1000 - 1
    : Number.POSITIVE_INFINITY
  return reportTime >= rangeStart && reportTime <= rangeEnd
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

async function fetchCityLayer(layer: number, signal: AbortSignal): Promise<Report[]> {
  const query = new URLSearchParams({
    where: '1=1',
    outFields: 'OBJECTID,CategoryName,StatusType,DateCreated,DateUpdated,CrossStreet,Neighborhood',
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '250',
    orderByFields: 'DateUpdated DESC',
    f: 'geojson',
  })
  const response = await fetch(`${CITY_LAYER_URL}/${layer}/query?${query}`, { signal })
  if (!response.ok) throw new Error(`City data request failed (${response.status}).`)

  const collection = await response.json() as ArcGisFeatureCollection
  if (collection.error) throw new Error(collection.error.message || 'The City of Sacramento data service returned an error.')

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
      id: `city-${layer}-${String(properties.OBJECTID ?? feature.id ?? crypto.randomUUID())}`,
      external_id: String(properties.OBJECTID ?? feature.id ?? ''),
      issue_type: issueType,
      severity: 'medium' as const,
      description: `${issueType === 'pothole' ? 'Pothole repair' : 'Street light repair'} recorded by the City${location ? ` near ${location}` : ''}.`,
      latitude: position.latitude,
      longitude: position.longitude,
      status: 'resolved' as const,
      source: 'city-of-sacramento' as const,
      created_at: date.toISOString(),
    }]
  })
}

async function fetchCityReports(signal: AbortSignal) {
  const [streetLights, potholes] = await Promise.all([
    fetchCityLayer(0, signal),
    fetchCityLayer(1, signal),
  ])
  return [...potholes, ...streetLights]
}

function MapClickHandler({ enabled, onSelect }: { enabled: boolean; onSelect: (latitude: number, longitude: number) => void }) {
  useMapEvents({
    click(event) {
      if (enabled) onSelect(event.latlng.lat, event.latlng.lng)
    },
  })
  return null
}

function RecenterButton() {
  const map = useMap()
  return (
    <button
      className="map-control"
      type="button"
      aria-label="Recenter map on Sacramento"
      title="Recenter map"
      onClick={() => map.flyTo([38.5816, -121.4944], 13, { duration: 0.8 })}
    >
      <Crosshair size={17} />
    </button>
  )
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

  useEffect(() => {
    if (!active || !location) return

    if (reports.length > 0) {
      const bounds = latLngBounds([
        [location.latitude, location.longitude],
        ...reports.map((report) => [report.latitude, report.longitude] as [number, number]),
      ])
      map.flyToBounds(bounds.pad(0.18), { maxZoom: 15, duration: 0.8 })
    } else {
      map.flyTo([location.latitude, location.longitude], 15, { duration: 0.8 })
    }
  }, [active, location, map, reports])

  return null
}

function ReportMarker({ report }: { report: Report }) {
  const color = issueColors[report.issue_type]
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
            <span className={`popup-status ${report.status}`}>{statusLabel(report.status)}</span>
          </div>
          <p>{report.description}</p>
          <div className="popup-meta">
            <span>{sourceLabel(report.source)}</span>
            <span>{new Date(report.created_at).toLocaleDateString()}</span>
          </div>
        </div>
      </Popup>
    </CircleMarker>
  )
}

function App() {
  const [cityReports, setCityReports] = useState<Report[]>([])
  const [userReports, setUserReports] = useState<Report[]>([])
  const [cityLoading, setCityLoading] = useState(true)
  const [reportsLoading, setReportsLoading] = useState(true)
  const [cityError, setCityError] = useState('')
  const [reportsError, setReportsError] = useState('')
  const [typeFilter, setTypeFilter] = useState<IssueType | 'all'>('all')
  const [visibleIssueTypes, setVisibleIssueTypes] = useState<IssueType[]>(issueTypes)
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter>('all')
  const [customStartDate, setCustomStartDate] = useState('')
  const [customEndDate, setCustomEndDate] = useState('')
  const [nearMeLocation, setNearMeLocation] = useState<Coordinates | null>(null)
  const [isNearMeActive, setIsNearMeActive] = useState(false)
  const [isLocating, setIsLocating] = useState(false)
  const [nearMeError, setNearMeError] = useState('')
  const [isPlacing, setIsPlacing] = useState(false)
  const [draftLocation, setDraftLocation] = useState<{ latitude: number; longitude: number } | null>(null)
  const [description, setDescription] = useState('')
  const [issueType, setIssueType] = useState<IssueType>('pothole')
  const [severity, setSeverity] = useState<Severity>('medium')
  const [isSaving, setIsSaving] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    let active = true
    setIsLocating(true)
    setNearMeError('')

    void getCurrentPosition()
      .then((location) => {
        if (active) {
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
    const controller = new AbortController()
    fetchCityReports(controller.signal)
      .then(setCityReports)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setCityError(error instanceof Error ? error.message : 'Unable to load City of Sacramento data.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setCityLoading(false)
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    let active = true
    async function loadReports() {
      try {
        if (supabase) {
          const { data, error } = await supabase
            .from('reports')
            .select('id, issue_type, description, severity, latitude, longitude, status, source, created_at, external_id')
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
            })))
          }
        } else {
          const savedReports: unknown = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]')
          if (!isReportArray(savedReports)) throw new Error('Saved reports have an unexpected format. Clear the browser storage and try again.')
          if (active) setUserReports(savedReports)
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

  const selectedCustomRangeError = dateFilter === 'custom'
    ? customRangeError(customStartDate, customEndDate)
    : ''
  const reports = useMemo(() => [...userReports, ...cityReports], [userReports, cityReports])
  const filteredReports = useMemo(() => reports.filter((report) =>
    (typeFilter === 'all' || report.issue_type === typeFilter) &&
    visibleIssueTypes.includes(report.issue_type) &&
    (sourceFilter === 'all' || report.source === sourceFilter) &&
    (statusFilter === 'all' || report.status === statusFilter) &&
    (dateFilter === 'all' ||
      (dateFilter === 'last-90-days' && Date.parse(report.created_at) >= Date.now() - LAST_90_DAYS_MS) ||
      (dateFilter === 'custom' && (
        !customStartDate && !customEndDate ||
        (!selectedCustomRangeError && isWithinCustomDateRange(report, customStartDate, customEndDate))
      ))) &&
    (!isNearMeActive || !nearMeLocation || distanceInKilometers(nearMeLocation, report) <= NEARBY_RADIUS_KM),
  ), [reports, typeFilter, visibleIssueTypes, sourceFilter, statusFilter, dateFilter, customStartDate, customEndDate, selectedCustomRangeError, isNearMeActive, nearMeLocation])

  const openCount = reports.filter((report) => report.status !== 'resolved').length
  const resolvedCount = reports.length - openCount
  const isLoading = cityLoading || reportsLoading

  function startPlacing() {
    setDraftLocation(null)
    setFormError('')
    setIsPlacing(true)
  }

  function cancelPlacing() {
    setDraftLocation(null)
    setIsPlacing(false)
    setFormError('')
  }

  function useMyLocation() {
    void getCurrentPosition()
      .then((location) => {
        setDraftLocation(location)
        setIsPlacing(true)
        setFormError('')
      })
      .catch((error: unknown) => setFormError(error instanceof Error ? error.message : 'Unable to get your location.'))
  }

  async function showProblemsNearMe() {
    if (isNearMeActive) {
      setIsNearMeActive(false)
      setNearMeLocation(null)
      setNearMeError('')
      return
    }

    setIsLocating(true)
    setNearMeError('')
    try {
      const location = await getCurrentPosition()
      setNearMeLocation(location)
      setIsNearMeActive(true)
    } catch (error) {
      setNearMeError(error instanceof Error ? error.message : 'Unable to get your location.')
    } finally {
      setIsLocating(false)
    }
  }

  function toggleIssueType(issue: IssueType) {
    setVisibleIssueTypes((current) =>
      current.includes(issue) ? current.filter((visibleType) => visibleType !== issue) : [...current, issue],
    )
  }

  async function submitReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
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

    setIsSaving(true)
    setFormError('')
    const report: Report = {
      id: crypto.randomUUID(),
      ...draftLocation,
      issue_type: issueType,
      description: cleanDescription,
      severity,
      status: 'open',
      source: 'user',
      created_at: new Date().toISOString(),
    }

    try {
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
          .select('id, issue_type, description, severity, latitude, longitude, status, source, created_at, external_id')
          .single()
        if (error) throw new Error(`Could not save your report: ${error.message}`)
        setUserReports((current) => [{
          ...report,
          id: data.id,
          created_at: data.created_at,
          external_id: data.external_id,
        }, ...current])
      } else {
        const nextReports = [report, ...userReports]
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(nextReports))
        setUserReports(nextReports)
      }
      setDescription('')
      setDraftLocation(null)
      setIsPlacing(false)
      setReportsError('')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save your report.')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Common Ground home">
          <span className="brand-mark"><Activity size={19} strokeWidth={2.2} /></span>
          <span className="brand-name">common<span>ground</span></span>
          <span className="brand-divider" />
          <span className="brand-place">SACRAMENTO, CA</span>
        </a>
        <div className="topbar-right">
          <span className="live-indicator"><span /> PUBLIC DATA</span>
          <button className={`top-report-button ${isPlacing ? 'active' : ''}`} onClick={isPlacing ? cancelPlacing : startPlacing} type="button">
            {isPlacing ? <X size={15} /> : <Plus size={16} />}
            {isPlacing ? 'Cancel report' : 'Report an issue'}
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <div className="eyebrow"><span className="eyebrow-line" /> CITY PULSE <span className="eyebrow-line" /></div>
            <h1>Better streets<br /><span>start here.</span></h1>
            <p className="intro">One shared view of the issues shaping our neighborhoods.</p>
          </div>

          <section className="stats-grid" aria-label="Report statistics">
            <div className="stat-card stat-total">
              <span className="stat-label">ON THE MAP</span>
              <strong>{isLoading ? '—' : reports.length.toLocaleString()}</strong>
              <span className="stat-caption">total reports</span>
              <span className="stat-icon"><MapPin size={15} /></span>
            </div>
            <div className="stat-card">
              <span className="stat-label">NEEDS ATTENTION</span>
              <strong>{isLoading ? '—' : openCount.toLocaleString()}</strong>
              <span className="stat-caption">open issues</span>
              <span className="stat-icon attention"><ArrowUpRight size={15} /></span>
            </div>
            <div className="stat-card">
              <span className="stat-label">TAKEN CARE OF</span>
              <strong>{isLoading ? '—' : resolvedCount.toLocaleString()}</strong>
              <span className="stat-caption">resolved</span>
              <span className="stat-icon resolved"><Check size={15} /></span>
            </div>
          </section>

          <section className="filter-section">
            <div className="section-title-row">
              <h2><Filter size={15} /> FILTER THE MAP</h2>
              <span className="result-count">{filteredReports.length} SHOWN</span>
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
            {nearMeError && <p className="inline-error near-me-error" role="alert"><AlertCircle size={14} /> {nearMeError}</p>}
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
              <span className="field-label">SHOW ON MAP</span>
              <div className="issue-checklist-items">
                {issueTypes.map((type) => (
                  <label className="issue-checkbox" key={type}>
                    <input
                      type="checkbox"
                      checked={visibleIssueTypes.includes(type)}
                      onChange={() => toggleIssueType(type)}
                    />
                    <span className="issue-checkbox-indicator" style={{ '--issue-color': issueColors[type] } as CSSProperties}>
                      {visibleIssueTypes.includes(type) && <Check size={11} />}
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
                  <select id="source-filter" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}>
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
                    <option value="open">Open</option>
                    <option value="in-progress">In progress</option>
                    <option value="resolved">Resolved</option>
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
            </div>
            <label className="field-label time-filter-label" htmlFor="date-filter">TIME PERIOD</label>
            <div className="select-wrap">
              <select id="date-filter" value={dateFilter} onChange={(event) => setDateFilter(event.target.value as DateFilter)}>
                <option value="all">Any time</option>
                <option value="last-90-days">Within the last 90 days</option>
                <option value="custom">Custom date range</option>
              </select>
              <ChevronDown size={15} />
            </div>
            {dateFilter === 'custom' && (
              <div className="custom-date-range">
                <label>
                  <span className="field-label">FROM</span>
                  <input type="date" value={customStartDate} onChange={(event) => setCustomStartDate(event.target.value)} />
                </label>
                <label>
                  <span className="field-label">TO</span>
                  <input type="date" value={customEndDate} onChange={(event) => setCustomEndDate(event.target.value)} />
                </label>
                {selectedCustomRangeError && (
                  <p className="inline-error date-range-error" role="alert">
                    <AlertCircle size={14} /> {selectedCustomRangeError}
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="legend-section">
            <div className="section-title-row"><h2><CircleDot size={15} /> MAP KEY</h2></div>
            <div className="legend-grid">
              {issueTypes.map((type) => (
                <div className="legend-item" key={type}>
                  <span className="legend-dot" style={{ backgroundColor: issueColors[type] }} />
                  <span>{issueLabel(type)}</span>
                </div>
              ))}
            </div>
            <div className="source-key"><span className="source-key-ring" /> Community report <span className="source-key-dot" /> City record</div>
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
              <form className="report-form" onSubmit={(event) => void submitReport(event)}>
                <label className="field-label" htmlFor="report-type">ISSUE TYPE</label>
                <div className="select-wrap">
                  <select id="report-type" value={issueType} onChange={(event) => setIssueType(event.target.value as IssueType)}>
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
            <div className="footer-bottom">
              <span>BUILT FOR THE BLOCK</span>
              <span>01 <span className="footer-slash">/</span> 01</span>
            </div>
          </div>
        </aside>

        <section className="map-panel" aria-label="Sacramento infrastructure map">
          <MapContainer
            center={[38.5816, -121.4944]}
            zoom={13}
            minZoom={10}
            maxZoom={19}
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
            <MapClickHandler enabled={isPlacing} onSelect={(latitude, longitude) => {
              setDraftLocation({ latitude, longitude })
              setFormError('')
            }} />
            <RecenterButton />
            <NearbyMapController active={isNearMeActive} location={nearMeLocation} reports={filteredReports} />
            {isNearMeActive && nearMeLocation && (
              <>
                <CircleMarker
                  center={[nearMeLocation.latitude, nearMeLocation.longitude]}
                  radius={16}
                  pathOptions={{ color: '#567052', fillColor: '#ffffff', fillOpacity: 0.92, weight: 3 }}
                />
                <CircleMarker
                  center={[nearMeLocation.latitude, nearMeLocation.longitude]}
                  radius={5}
                  pathOptions={{ color: '#567052', fillColor: '#567052', fillOpacity: 1, weight: 1 }}
                />
              </>
            )}
            {filteredReports.map((report) => <ReportMarker key={report.id} report={report} />)}
            {draftLocation && (
              <CircleMarker
                center={[draftLocation.latitude, draftLocation.longitude]}
                radius={11}
                pathOptions={{ color: '#282b26', fillColor: issueColors[issueType], fillOpacity: 0.5, weight: 3, dashArray: '4 5' }}
              />
            )}
          </MapContainer>
          <div className="map-overlay map-overlay-top"><span className="map-area-dot" /> SACRAMENTO <span className="map-overlay-divider">/</span> CENTRAL CITY</div>
          <div className="map-overlay map-overlay-bottom"><span>38°34'54.0"N&nbsp; 121°29'39.8"W</span><span className="map-overlay-divider">·</span><span>MAP DATA © OPENSTREETMAP</span></div>
          {isPlacing && !draftLocation && <div className="map-instruction"><ArrowDown size={15} /> Click the map to place your report</div>}
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
