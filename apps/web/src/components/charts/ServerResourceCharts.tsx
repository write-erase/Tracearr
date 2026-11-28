import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Highcharts from 'highcharts';
import { HighchartsReact } from 'highcharts-react-official';
import { SERVER_STATS_CONFIG, type ServerResourceDataPoint } from '@tracearr/shared';
import {
  liveStatsTimeAxis,
  nearestPointTooltip,
  useSlidingWindow,
  withGaps,
} from './liveStatsAxis';
import { ChartSkeleton } from '@/components/ui/skeleton';
import { ChartEmpty } from './ChartEmpty';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Cpu, MemoryStick } from 'lucide-react';

const COLORS = {
  process: 'oklch(var(--chart-1))',
  system: 'oklch(var(--chart-2))',
  processGradientStart: 'oklch(var(--chart-1) / 0.3)',
  processGradientEnd: 'oklch(var(--chart-1) / 0.05)',
  systemGradientStart: 'oklch(var(--chart-2) / 0.3)',
  systemGradientEnd: 'oklch(var(--chart-2) / 0.05)',
};

// In highcharts-react's effect deps - inline literals would update per render
const UPDATE_ARGS: [boolean, boolean, boolean] = [true, true, false];
// No height: the chart sets its own (180px). A 100% height resolves against the card's stretched
// content in a dashboard grid row, which includes the average chips below the chart, so the
// chips were pushed out past the card's bottom edge once they wrapped (fork).
const CONTAINER_PROPS = { style: { width: '100%' } };

type ProcessKey = 'processCpuUtilization' | 'processMemoryUtilization';
type HostKey = 'hostCpuUtilization' | 'hostMemoryUtilization';

export interface ResourceMultiSeries {
  serverId: string;
  serverName: string;
  color: string;
  /** How long this server's line may go without a sample before it breaks. */
  gapSeconds: number;
  /**
   * Draw the host figure for a metric the server's process doesn't report (fork). Set for
   * Dispatcharr and Channels DVR; any other server with no process figure is left off that chart.
   */
  hostFallback?: boolean;
  data: ServerResourceDataPoint[];
}

interface ServerResourceChartsProps {
  data: ServerResourceDataPoint[] | undefined;
  isLoading?: boolean;
  averages?: {
    hostCpu: number | null;
    processCpu: number | null;
    hostMemory: number | null;
    processMemory: number | null;
  } | null;
  /** One per-server line each; host metrics are dropped in this mode */
  multiSeries?: ResourceMultiSeries[];
  /** Single-view name for the process series */
  processLabel?: string;
  /** Single-view counterpart of a series' gapSeconds */
  gapSeconds?: number;
  clockSkewMs?: number;
}

interface ResourceChartProps extends Omit<ServerResourceChartsProps, 'averages'> {
  title: string;
  icon: React.ReactNode;
  processKey: ProcessKey;
  hostKey: HostKey;
  processAvg?: number | null;
  hostAvg?: number | null;
}

const pointsFor = (
  data: ServerResourceDataPoint[],
  key: ProcessKey | HostKey
): [number, number | null][] => data.map((p) => [p.at * 1000, p[key]]);

function AverageChip({ color, value }: { color: string; value: number | null | undefined }) {
  const { t } = useTranslation('pages');
  return (
    <span>
      <span style={{ color }}>●</span> {t('dashboard.resources.average')}{' '}
      <span className="text-foreground font-medium">{value ?? '—'}%</span>
    </span>
  );
}

// A fork source that reports no process figure (Channels DVR has no process CPU) falls
// back to the host figure in the per-server view so it still draws a line
function multiKeyFor(
  s: ResourceMultiSeries,
  processKey: ProcessKey,
  hostKey: HostKey
): ProcessKey | HostKey | null {
  if (s.data.some((p) => p[processKey] != null)) return processKey;
  return s.hostFallback && s.data.some((p) => p[hostKey] != null) ? hostKey : null;
}

function ResourceChart({
  title,
  icon,
  data,
  processKey,
  hostKey,
  processAvg,
  hostAvg,
  isLoading,
  multiSeries,
  processLabel,
  gapSeconds: gap = SERVER_STATS_CONFIG.GAP_BREAK_SECONDS,
  clockSkewMs = 0,
}: ResourceChartProps) {
  const { t } = useTranslation(['pages', 'common']);
  const chartRef = useRef<HighchartsReact.RefObject | null>(null);
  const isMulti = !!multiSeries && multiSeries.length > 0;
  // A server that reports nothing gets no line and no average, not an empty one. One that reports
  // no process figure is drawn from its host figure when it is a fork source (Channels DVR has
  // no process CPU), and left off the chart otherwise.
  const plotted = useMemo(
    () =>
      (multiSeries ?? []).flatMap((s) => {
        const key = multiKeyFor(s, processKey, hostKey);
        return key ? [{ ...s, key }] : [];
      }),
    [multiSeries, processKey, hostKey]
  );
  const processPlotted = !!data?.some((p) => p[processKey] != null);
  const hasData = isMulti ? plotted.length > 0 : !!data?.length;

  useSlidingWindow(chartRef, clockSkewMs);

  const chartOptions = useMemo<Highcharts.Options>(() => {
    if (!hasData) return {};

    const processSeries: Highcharts.SeriesOptionsType = {
      type: 'area',
      ...(processLabel === undefined ? {} : { name: processLabel }),
      color: COLORS.process,
      data: withGaps(pointsFor(data ?? [], processKey), gap),
      fillColor: {
        linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
        stops: [
          [0, COLORS.processGradientStart],
          [1, COLORS.processGradientEnd],
        ],
      },
    };
    const systemSeries: Highcharts.SeriesOptionsType = {
      type: 'area',
      name: t('dashboard.resources.system'),
      color: COLORS.system,
      data: withGaps(pointsFor(data ?? [], hostKey), gap),
      fillColor: {
        linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
        stops: [
          [0, COLORS.systemGradientStart],
          [1, COLORS.systemGradientEnd],
        ],
      },
    };

    // Host metrics belong to the box: N co-hosted servers, N identical lines
    const series: Highcharts.SeriesOptionsType[] = isMulti
      ? plotted.map(({ key, ...s }) => ({
          type: 'line' as const,
          name:
            key === processKey
              ? s.serverName
              : `${s.serverName} (${t('dashboard.resources.system')})`,
          color: s.color,
          data: withGaps(pointsFor(s.data, key), s.gapSeconds),
        }))
      : processPlotted
        ? [processSeries, systemSeries]
        : [systemSeries];

    const values = series.flatMap((s) =>
      ((s as { data?: [number, number | null][] }).data ?? [])
        .map(([, y]) => y)
        .filter((v): v is number => v != null)
    );
    const maxValue = Math.max(...values, 0);

    // Process metrics idle near zero; only host values need a coarse scale
    const yMax =
      maxValue <= 5 ? Math.max(2, Math.ceil(maxValue * 1.3)) : Math.ceil(maxValue / 10) * 10;

    return {
      chart: {
        type: 'area',
        height: 180,
        backgroundColor: 'transparent',
        style: { fontFamily: 'inherit' },
        spacing: [0, 10, 15, 10],
        reflow: true,
      },
      title: { text: undefined },
      credits: { enabled: false },
      legend: {
        enabled: true,
        align: 'left',
        verticalAlign: 'top',
        floating: false,
        itemStyle: {
          color: 'oklch(var(--muted-foreground))',
          fontWeight: 'normal',
          // 11px, as before 3.2.1: at 12px the server names wrap to a third row and the legend pages (fork)
          fontSize: '11px',
        },
        itemHoverStyle: { color: 'oklch(var(--foreground))' },
      },
      xAxis: liveStatsTimeAxis(Date.now() + clockSkewMs),
      yAxis: {
        title: { text: undefined },
        labels: {
          style: { color: 'oklch(var(--muted-foreground))', fontSize: '12px' },
          format: '{value}%',
        },
        gridLineColor: 'oklch(var(--border) / 0.5)',
        min: 0,
        max: yMax,
        tickInterval: yMax <= 10 ? 1 : yMax <= 20 ? 5 : 10,
      },
      plotOptions: {
        series: {
          marker: { enabled: false, states: { hover: { enabled: true, radius: 3 } } },
          lineWidth: 2,
          states: { hover: { lineWidth: 2 } },
          connectNulls: false,
        },
        area: { threshold: null },
      },
      tooltip: {
        backgroundColor: 'oklch(var(--popover))',
        borderColor: 'oklch(var(--border))',
        style: { color: 'oklch(var(--popover-foreground))', fontSize: '12px' },
        formatter: nearestPointTooltip((y) => `${Math.round(y)}%`),
      },
      series,
      responsive: {
        rules: [
          {
            condition: { maxWidth: 400 },
            chartOptions: {
              legend: {
                align: 'center',
                layout: 'horizontal',
                itemStyle: { fontSize: '10px' },
              },
              xAxis: liveStatsTimeAxis(Date.now() + clockSkewMs, true),
            },
          },
        ],
      },
    };
  }, [
    data,
    processKey,
    hostKey,
    plotted,
    processPlotted,
    isMulti,
    hasData,
    processLabel,
    gap,
    clockSkewMs,
    t,
  ]);

  const header = (
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-sm font-medium">
        {icon}
        {title}
        {/* Per-process, not per-host: an order of magnitude smaller */}
        {isMulti && (
          <span className="text-muted-foreground font-normal">
            {t('dashboard.resources.perServer')}
          </span>
        )}
      </CardTitle>
    </CardHeader>
  );

  if (isLoading) {
    return (
      <Card>
        {header}
        <CardContent>
          <ChartSkeleton height={180} />
        </CardContent>
      </Card>
    );
  }

  if (!hasData) {
    return (
      <Card>
        {header}
        <CardContent>
          <ChartEmpty height={180} message={t('common:empty.noData')} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {header}
      <CardContent>
        <HighchartsReact
          ref={chartRef}
          highcharts={Highcharts}
          options={chartOptions}
          // animation:false, or the default swing cancels the in-flight pan
          updateArgs={UPDATE_ARGS}
          containerProps={CONTAINER_PROPS}
        />
        <div className="text-muted-foreground mt-1 flex flex-wrap justify-end gap-4 pr-2 text-xs">
          {isMulti ? (
            plotted.map(({ key, ...s }) => {
              const values = s.data.map((p) => p[key]).filter((v): v is number => v != null);
              const avg =
                values.length > 0
                  ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
                  : null;
              return <AverageChip key={s.serverId} color={s.color} value={avg} />;
            })
          ) : (
            <>
              {processPlotted && <AverageChip color={COLORS.process} value={processAvg} />}
              <AverageChip color={COLORS.system} value={hostAvg} />
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Live CPU and RAM utilization, one card each. */
export function ServerResourceCharts({
  data,
  isLoading,
  averages,
  multiSeries,
  processLabel,
  gapSeconds,
  clockSkewMs,
}: ServerResourceChartsProps) {
  const shared = { data, isLoading, multiSeries, processLabel, gapSeconds, clockSkewMs };

  return (
    <>
      <ResourceChart
        {...shared}
        title="CPU"
        icon={<Cpu className="h-4 w-4" />}
        processKey="processCpuUtilization"
        hostKey="hostCpuUtilization"
        processAvg={averages?.processCpu}
        hostAvg={averages?.hostCpu}
      />
      <ResourceChart
        {...shared}
        title="RAM"
        icon={<MemoryStick className="h-4 w-4" />}
        processKey="processMemoryUtilization"
        hostKey="hostMemoryUtilization"
        processAvg={averages?.processMemory}
        hostAvg={averages?.hostMemory}
      />
    </>
  );
}
