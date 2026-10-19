import logging
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd
from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError
from pygeoapi.util import get_current_datetime

log = logging.getLogger(__name__)

EVT_DIR = Path("/data/EVT")

METADATA = {
    "version": "1.0",
    "id": "chart-statistics",
    "title": "Event count chart statistics",
    "description": "Sliding window event count over all EVT data, returned as chart-ready JSON",
    "jobControlOptions": ["async-execute"],
    "inputs": {
        "window_size": {
            "title": "Window size (days)",
            "description": "Number of days in each sliding window",
            "schema": {
                "type": "integer",
                "default": 30,
            },
        },
        "slide_size": {
            "title": "Slide size (days)",
            "description": "Number of days to advance the window",
            "schema": {
                "type": "integer",
                "default": 30,
            },
        },
    },
    "outputs": {
        "chart_data": {
            "title": "Chart data",
            "description": "Sliding window event counts with visualization metadata for line chart rendering",
            "schema": {"type": "object"},
        }
    },
}


def parse_timestamp(s):
    """Parse SAS datetime like '01JAN2015:00:06:01.000' into a datetime object."""
    normalized = s[:2] + s[2:5].capitalize() + s[5:]
    return datetime.strptime(normalized, "%d%b%Y:%H:%M:%S.%f")


def parse_timestamp_safe(s):
    """Parse timestamp, returning None on failure."""
    if not isinstance(s, str) or not s.strip():
        return None
    try:
        return parse_timestamp(s.strip())
    except (ValueError, IndexError):
        return None


class ChartStatisticsProcessor(BaseProcessor):
    """Processor for sliding window event count chart statistics."""

    def __init__(self, processor_def):
        super().__init__(processor_def, METADATA)
        self.job_id = None

    def set_job_id(self, job_id):
        self.job_id = job_id

    def _update_progress(self, progress, message):
        log.info(f"[{progress}%] {message}")
        if self.job_id is None:
            return
        try:
            from pygeoapi.flask_app import api_

            api_.manager.update_job(
                self.job_id,
                {
                    "progress": progress,
                    "message": message,
                    "updated": get_current_datetime(),
                },
            )
        except Exception as e:
            log.warning(f"Could not update job progress: {e}")

    def execute(self, data, outputs=None):
        log.info("Starting chart-statistics process")
        return self._run(data)

    def _run(self, data):
        window_size = int(data.get("window_size", 30))
        slide_size = int(data.get("slide_size", 30))

        if window_size < 1:
            raise ProcessorExecuteError("window_size must be at least 1")
        if slide_size < 1:
            raise ProcessorExecuteError("slide_size must be at least 1")

        # --- Read all EVT files ---
        self._update_progress(10, "Reading event files")
        evt_files = sorted(EVT_DIR.glob("*.tab"))
        if not evt_files:
            raise ProcessorExecuteError(f"No .tab files found in {EVT_DIR}")

        dfs = []
        for evt_file in evt_files:
            df = pd.read_csv(
                evt_file,
                sep="\t",
                encoding="latin-1",
                usecols=["INVIO"],
                dtype={"INVIO": str},
            )
            dfs.append(df)

        events = pd.concat(dfs, ignore_index=True)
        log.info(f"Read {len(events)} raw events")

        # --- Parse timestamps ---
        self._update_progress(40, "Parsing timestamps")
        events["invio_dt"] = events["INVIO"].apply(parse_timestamp_safe)
        events = events.dropna(subset=["invio_dt"])
        log.info(f"Events with valid timestamps: {len(events)}")

        if events.empty:
            raise ProcessorExecuteError("No events with valid timestamps found")

        # --- Generate sliding windows ---
        self._update_progress(60, "Computing sliding window counts")
        min_time = events["invio_dt"].min()
        max_time = events["invio_dt"].max()

        window_delta = timedelta(days=window_size)
        slide_delta = timedelta(days=slide_size)

        window_start = min_time.replace(hour=0, minute=0, second=0, microsecond=0)
        data_points = []

        while window_start < max_time:
            window_end = window_start + window_delta
            mask = (events["invio_dt"] >= window_start) & (
                events["invio_dt"] < window_end
            )
            count = int(mask.sum())
            data_points.append(
                {
                    "window_start": window_start.strftime("%Y-%m-%d"),
                    "window_end": window_end.strftime("%Y-%m-%d"),
                    "count": count,
                }
            )
            window_start += slide_delta

        log.info(f"Generated {len(data_points)} windows")
        self._update_progress(90, f"Generated {len(data_points)} windows")

        result = {
            "chart_data": {
                "visualization": {
                    "type": "line_chart",
                    "x": {"field": "window_start", "label": "Time"},
                    "y": {"field": "count", "label": "Event Count"},
                },
                "data": data_points,
            }
        }

        return "application/json", result

    def __repr__(self):
        return "<ChartStatisticsProcessor>"
