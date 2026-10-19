/**
 * OGC API - Processes Client Plugin for QWC2
 *
 * Allows users to browse, configure, and execute geoprocessing tasks
 * served by a pygeoapi OGC API - Processes server.
 *
 * The sidebar has two tabs:
 *   "New Job"  — select a process, fill inputs, execute
 *   "Jobs"     — list all jobs from GET /jobs; click a completed job to view
 *               results in a floating ResizeableWindow; click a running job
 *               to resume polling.
 */

import React from 'react';
import { connect } from 'react-redux';

import axios from 'axios';
import PropTypes from 'prop-types';
import { processFinished, processStarted } from 'qwc2/actions/processNotifications';
import ResizeableWindow from 'qwc2/components/ResizeableWindow';
import SideBar from 'qwc2/components/SideBar';
import ButtonBar from 'qwc2/components/widgets/ButtonBar';
import ComboBox from 'qwc2/components/widgets/ComboBox';
import NumberInput from 'qwc2/components/widgets/NumberInput';
import Spinner from 'qwc2/components/widgets/Spinner';
import {
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis
} from 'recharts';

import './style/OGCProcessClient.css';


const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 1500;

const TAB_BUTTONS = [
    { key: 'new', label: 'New Job' },
    { key: 'jobs', label: 'Jobs' }
];

class OGCProcessClient extends React.Component {
    static propTypes = {
        /** The currently active theme object from Redux state */
        currentTheme: PropTypes.object,
        processFinished: PropTypes.func,
        processStarted: PropTypes.func,
        /** URL of the pygeoapi server (base URL, e.g. http://localhost:8088) */
        pygeoApiUrl: PropTypes.string.isRequired,
        /** The side of the application on which to display the sidebar */
        side: PropTypes.string
    };
    static defaultProps = {
        side: 'right'
    };

    state = {
        // Tab
        activeTab: 'new',
        // Process list
        processes: [],
        loadingProcesses: false,
        // Selected process
        selectedProcessId: '',
        processDescription: null,
        loadingDescription: false,
        // Form inputs
        formValues: {},
        validationErrors: {},
        // Execution
        executing: false,
        statusMessage: null,
        statusPercent: null,
        // Jobs list
        jobsList: [],
        loadingJobs: false,
        // Results window
        resultsWindowVisible: false,
        resultsWindowTitle: 'Job Results',
        results: null,
        error: null
    };

    pollTimer = null;
    pollCount = 0;

    componentWillUnmount() {
        this.stopPolling();
    }

    // =========================================================================
    // OGC API - Processes: List processes
    // =========================================================================

    fetchProcesses = () => {
        const { pygeoApiUrl } = this.props;
        this.setState({ loadingProcesses: true, processes: [], error: null });

        axios.get(`${pygeoApiUrl}/processes`, {
            headers: { Accept: 'application/json' }
        })
            .then(response => {
                const processes = this.extractProcesses(response.data);
                this.setState({ processes, loadingProcesses: false });
            })
            .catch(err => {
                this.setState({
                    loadingProcesses: false,
                    error: 'Failed to fetch processes: ' + (err.message || 'Unknown error')
                });
            });
    };

    extractProcesses = (data) => {
        try {
            const list = data.processes || [];
            return list.map(p => ({
                identifier: p.id || '',
                title: p.title || p.id || '',
                abstract: p.description || ''
            }));
        } catch {
            return [];
        }
    };

    // =========================================================================
    // OGC API - Processes: Describe process
    // =========================================================================

    fetchProcessDescription = (identifier) => {
        const { pygeoApiUrl } = this.props;
        this.setState({ loadingDescription: true, processDescription: null, formValues: {}, validationErrors: {}, results: null, error: null });

        axios.get(`${pygeoApiUrl}/processes/${identifier}`, {
            headers: { Accept: 'application/json' }
        })
            .then(response => {
                const description = this.extractDescription(response.data);
                // Initialize form with default values
                const formValues = {};
                if (description && description.inputs) {
                    description.inputs.forEach(input => {
                        formValues[input.identifier] = input.defaultValue || '';
                    });
                }
                this.setState({ processDescription: description, loadingDescription: false, formValues });
            })
            .catch(err => {
                this.setState({
                    loadingDescription: false,
                    error: 'Failed to describe process: ' + (err.message || 'Unknown error')
                });
            });
    };

    extractDescription = (data) => {
        try {
            const inputs = [];
            const inputDefs = data.inputs || {};

            Object.keys(inputDefs).forEach(key => {
                const inputDef = inputDefs[key];
                const schema = inputDef.schema || {};
                const minOccurs = inputDef.minOccurs !== undefined ? inputDef.minOccurs : 1;

                let dataType = 'string';
                if (schema.type === 'integer') {
                    dataType = 'integer';
                } else if (schema.type === 'number') {
                    dataType = 'float';
                } else if (schema.type === 'boolean') {
                    dataType = 'boolean';
                }

                let allowedValues = null;
                if (schema.enum) {
                    allowedValues = schema.enum.map(v => v.toString());
                }

                const defaultValue = schema.default !== undefined ? schema.default.toString() : '';

                inputs.push({
                    identifier: key,
                    title: inputDef.title || key,
                    abstract: inputDef.description || '',
                    dataType,
                    minOccurs,
                    allowedValues,
                    defaultValue
                });
            });

            const outputs = [];
            const outputDefs = data.outputs || {};
            Object.keys(outputDefs).forEach(key => {
                const outputDef = outputDefs[key];
                outputs.push({
                    identifier: key,
                    title: outputDef.title || key,
                    abstract: outputDef.description || ''
                });
            });

            // Check if async execution is supported
            const jobControlOptions = data.jobControlOptions || [];
            const asyncSupported = jobControlOptions.includes('async-execute');

            return {
                identifier: data.id || '',
                title: data.title || '',
                abstract: data.description || '',
                asyncSupported,
                inputs,
                outputs
            };
        } catch {
            return null;
        }
    };

    // =========================================================================
    // OGC API - Processes: Jobs list
    // =========================================================================

    fetchJobs = () => {
        const { pygeoApiUrl } = this.props;
        this.setState({ loadingJobs: true, error: null });

        axios.get(`${pygeoApiUrl}/jobs`, {
            headers: { Accept: 'application/json' }
        })
            .then(response => {
                const jobsList = this.extractJobs(response.data);
                this.setState({ jobsList, loadingJobs: false });
            })
            .catch(err => {
                this.setState({
                    loadingJobs: false,
                    error: 'Failed to fetch jobs: ' + (err.message || 'Unknown error')
                });
            });
    };

    extractJobs = (data) => {
        try {
            // pygeoapi returns { jobs: [...] } or just an array
            const list = Array.isArray(data) ? data : (data.jobs || []);
            return list.map(j => ({
                jobID: j.jobID || j.id || '',
                processID: j.processID || j.process_id || '',
                status: j.status || 'unknown',
                created: j.created || j.started || null,
                finished: j.finished || j.updated || null,
                message: j.message || ''
            })).sort((a, b) => {
                // Most-recent first
                if (!a.created && !b.created) return 0;
                if (!a.created) return 1;
                if (!b.created) return -1;
                return b.created.localeCompare(a.created);
            });
        } catch {
            return [];
        }
    };

    handleJobRowClick = (job) => {
        const { pygeoApiUrl } = this.props;

        if (job.status === 'successful') {
            // Fetch results and open the window
            const processId = job.processID + '_' + job.jobID;
            this.handleJobCompleted(job, processId);
        } else if (job.status === 'running' || job.status === 'accepted') {
            // Resume polling — switch to New Job tab so the progress shows
            const jobUrl = `${pygeoApiUrl}/jobs/${job.jobID}`;
            const processId = job.processID + '_' + job.jobID;
            this.stopPolling();
            this.setState({
                activeTab: 'new',
                executing: true,
                error: null,
                statusMessage: job.message || null,
                statusPercent: null
            });
            this.props.processStarted(processId, job.processID);
            this.startPolling(jobUrl, processId);
        } else if (job.status === 'failed') {
            this.setState({ error: 'Job ' + job.jobID + ' failed: ' + (job.message || 'No details available') });
        }
    };

    // =========================================================================
    // Form handling
    // =========================================================================

    handleInputChange = (identifier, value) => {
        this.setState(prevState => ({
            formValues: { ...prevState.formValues, [identifier]: value },
            validationErrors: { ...prevState.validationErrors, [identifier]: null }
        }));
    };

    validateForm = () => {
        const { processDescription, formValues } = this.state;
        if (!processDescription) return false;

        const errors = {};
        let valid = true;

        processDescription.inputs.forEach(input => {
            const value = formValues[input.identifier];
            // Required check
            if (input.minOccurs > 0 && (!value && value !== 0)) {
                errors[input.identifier] = 'This field is required';
                valid = false;
            }
            // Type check
            if (value && input.dataType === 'integer') {
                if (!/^-?\d+$/.test(value.toString())) {
                    errors[input.identifier] = 'Must be an integer';
                    valid = false;
                }
            }
            if (value && input.dataType === 'float') {
                if (isNaN(parseFloat(value))) {
                    errors[input.identifier] = 'Must be a number';
                    valid = false;
                }
            }
        });

        this.setState({ validationErrors: errors });
        return valid;
    };

    // =========================================================================
    // OGC API - Processes: Execute
    // =========================================================================

    executeProcess = () => {
        if (!this.validateForm()) return;

        const { processDescription, formValues } = this.state;
        if (!processDescription) return;

        const useAsync = processDescription.asyncSupported;
        const requestBody = this.buildExecuteRequest(processDescription, formValues);

        this.setState({ executing: true, results: null, error: null, statusMessage: null, statusPercent: null });

        const processId = processDescription.identifier + '_' + Date.now();
        if (useAsync) {
            this.props.processStarted(processId, processDescription.title);
        }

        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        if (useAsync) {
            headers.Prefer = 'respond-async';
        }

        const { pygeoApiUrl } = this.props;
        axios.post(
            `${pygeoApiUrl}/processes/${processDescription.identifier}/execution`,
            requestBody,
            { headers }
        )
            .then(response => {
                if (useAsync && (response.status === 201 || response.status === 200)) {
                    // Async: check for Location header or jobId in response
                    const locationHeader = response.headers.location || response.headers.Location;
                    const jobData = response.data;

                    if (jobData && jobData.status === 'successful') {
                        // Process completed synchronously despite async request
                        this.handleJobCompleted(jobData, processId);
                        return;
                    }

                    let jobUrl = locationHeader;
                    if (!jobUrl && jobData && jobData.jobID) {
                        jobUrl = `${pygeoApiUrl}/jobs/${jobData.jobID}`;
                    }

                    if (jobUrl) {
                        const progress = this.extractJobProgress(jobData);
                        this.setState({
                            statusPercent: progress.percent,
                            statusMessage: progress.message
                        });
                        this.startPolling(jobUrl, processId);
                    } else {
                        this.setState({ executing: false, error: 'No job location returned' });
                        this.props.processFinished(processId, false, 'No job location');
                    }
                } else {
                    // Synchronous response - results directly in body
                    const outputs = this.extractResults(response.data);
                    if (outputs) {
                        this.setState({
                            executing: false,
                            resultsWindowVisible: true,
                            resultsWindowTitle: 'Results: ' + processDescription.title,
                            results: outputs
                        });
                    } else {
                        this.setState({ executing: false, error: 'No outputs returned' });
                    }
                }
            })
            .catch(err => {
                const detail = err.response && err.response.data
                    ? (err.response.data.detail || err.response.data.description || JSON.stringify(err.response.data))
                    : (err.message || 'Unknown error');
                const errMsg = 'Execution failed: ' + detail;
                this.setState({ executing: false, error: errMsg, statusMessage: null, statusPercent: null });
                if (useAsync) {
                    this.props.processFinished(processId, false, errMsg);
                }
            });
    };

    buildExecuteRequest = (description, values) => {
        const inputs = {};
        description.inputs.forEach(input => {
            const value = values[input.identifier];
            if (value !== '' && value !== undefined) {
                // Convert to appropriate type
                if (input.dataType === 'integer') {
                    inputs[input.identifier] = parseInt(value, 10);
                } else if (input.dataType === 'float') {
                    inputs[input.identifier] = parseFloat(value);
                } else if (input.dataType === 'boolean') {
                    inputs[input.identifier] = value === 'true';
                } else {
                    inputs[input.identifier] = value;
                }
            }
        });

        return { inputs };
    };

    // =========================================================================
    // Async polling
    // =========================================================================

    startPolling = (jobUrl, processId) => {
        this.pollCount = 0;
        this.pollProcessId = processId;
        this.pollJobUrl = jobUrl;
        this.pollTimer = setInterval(() => this.pollStatus(), POLL_INTERVAL_MS);
    };

    stopPolling = () => {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    };

    pollStatus = () => {
        this.pollCount++;
        if (this.pollCount > MAX_POLL_ATTEMPTS) {
            this.stopPolling();
            const errMsg = 'Process timed out after ' + (MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000) + ' seconds';
            this.setState({ executing: false, error: errMsg, statusMessage: null, statusPercent: null });
            this.props.processFinished(this.pollProcessId, false, errMsg);
            return;
        }

        axios.get(this.pollJobUrl, {
            headers: { Accept: 'application/json' }
        })
            .then(response => {
                const jobData = response.data;
                const status = jobData.status;

                if (status === 'successful') {
                    this.stopPolling();
                    this.handleJobCompleted(jobData, this.pollProcessId);
                } else if (status === 'failed') {
                    this.stopPolling();
                    const failMsg = jobData.message || 'Process failed';
                    this.setState({ executing: false, error: failMsg, statusMessage: null, statusPercent: null });
                    this.props.processFinished(this.pollProcessId, false, failMsg);
                } else if (status === 'dismissed') {
                    this.stopPolling();
                    this.setState({ executing: false, error: 'Process was dismissed', statusMessage: null, statusPercent: null });
                    this.props.processFinished(this.pollProcessId, false, 'Process dismissed');
                } else {
                    // accepted / running - update progress and keep polling
                    const progress = this.extractJobProgress(jobData);
                    this.setState({
                        statusPercent: progress.percent,
                        statusMessage: progress.message
                    });
                }
            })
            .catch(err => {
                this.stopPolling();
                const errMsg = 'Polling failed: ' + (err.message || 'Unknown error');
                this.setState({ executing: false, error: errMsg, statusMessage: null, statusPercent: null });
                this.props.processFinished(this.pollProcessId, false, errMsg);
            });
    };

    // =========================================================================
    // Response parsing helpers
    // =========================================================================

    handleJobCompleted = (jobData, processId) => {
        const { pygeoApiUrl } = this.props;
        const jobId = jobData.jobID;
        const processTitle = jobData.processID || (processId || '').split('_')[0] || 'Process';

        const onResults = (outputs) => {
            this.setState({
                executing: false,
                statusMessage: null,
                statusPercent: null,
                results: outputs,
                resultsWindowVisible: true,
                resultsWindowTitle: 'Results: ' + processTitle
            });
            this.props.processFinished(processId, true, 'Process completed');
        };

        const onError = (errMsg) => {
            this.setState({ executing: false, error: errMsg, statusMessage: null, statusPercent: null });
            this.props.processFinished(processId, false, errMsg);
        };

        if (!jobId) {
            // Results might be inline in the job data
            const outputs = this.extractResults(jobData);
            onResults(outputs);
            return;
        }

        axios.get(`${pygeoApiUrl}/jobs/${jobId}/results`, {
            headers: { Accept: 'application/json' }
        })
            .then(response => {
                const outputs = this.extractResults(response.data);
                onResults(outputs);
            })
            .catch(err => {
                onError('Failed to fetch results: ' + (err.message || 'Unknown error'));
            });
    };

    extractJobProgress = (jobData) => {
        if (!jobData) return { percent: null, message: null };
        const percent = jobData.progress !== undefined ? jobData.progress : null;
        const message = jobData.message || null;
        return { percent, message };
    };

    extractResults = (data) => {
        if (!data) return null;

        // OGC API - Processes returns results as a JSON object with output keys
        const outputs = [];
        Object.keys(data).forEach(key => {
            const value = data[key];
            let parsed = value;
            // If the server returned a JSON string, attempt to parse it so we
            // can inspect the visualization metadata later.
            if (typeof value === 'string') {
                try {
                    parsed = JSON.parse(value);
                } catch {
                    parsed = value;
                }
            }
            outputs.push({
                identifier: key,
                title: key,
                value: parsed
            });
        });

        return outputs.length > 0 ? outputs : null;
    };

    // =========================================================================
    // Event handlers
    // =========================================================================

    onProcessSelected = (identifier) => {
        this.setState({ selectedProcessId: identifier, results: null, error: null });
        if (identifier) {
            this.fetchProcessDescription(identifier);
        } else {
            this.setState({ processDescription: null, formValues: {}, validationErrors: {} });
        }
    };

    onTabChange = (tab) => {
        this.setState({ activeTab: tab, error: null });
        if (tab === 'jobs') {
            this.fetchJobs();
        } else if (tab === 'new' && this.state.processes.length === 0) {
            this.fetchProcesses();
        }
    };

    onShow = () => {
        this.fetchProcesses();
    };

    onHide = () => {
        this.stopPolling();
        this.setState({
            activeTab: 'new',
            processes: [],
            selectedProcessId: '',
            processDescription: null,
            formValues: {},
            validationErrors: {},
            executing: false,
            statusMessage: null,
            statusPercent: null,
            jobsList: [],
            loadingJobs: false,
            resultsWindowVisible: false,
            results: null,
            error: null
        });
    };

    closeResultsWindow = () => {
        this.setState({ resultsWindowVisible: false, results: null });
    };

    // =========================================================================
    // Render
    // =========================================================================

    render() {
        return (
            <SideBar
                icon="gears"
                id="OGCProcessClient"
                onHide={this.onHide}
                onShow={this.onShow}
                side={this.props.side}
                title="Geoprocessing"
                width="20em"
            >
                {() => ({
                    body: this.renderBody(),
                    extra: this.renderResultsWindow()
                })}
            </SideBar>
        );
    }

    renderBody = () => {
        const { activeTab, error } = this.state;

        return (
            <div className="wps-client-body">
                <div className="wps-client-tab-bar">
                    <ButtonBar
                        active={activeTab}
                        buttons={TAB_BUTTONS}
                        onClick={this.onTabChange}
                    />
                </div>
                {activeTab === 'new' ? this.renderNewJobView() : this.renderJobsList()}
                {error && <div className="wps-client-error">{error}</div>}
            </div>
        );
    };

    renderNewJobView = () => {
        const { loadingProcesses } = this.state;

        return (
            <div className="wps-client-new-job">
                {this.renderProcessSelector()}
                {loadingProcesses && <div className="wps-client-loading"><Spinner /> Loading processes...</div>}
                {this.renderForm()}
            </div>
        );
    };

    renderProcessSelector = () => {
        const { processes, selectedProcessId, loadingProcesses } = this.state;

        if (loadingProcesses) return null;

        return (
            <div className="wps-client-section">
                <label className="wps-client-label">Process:</label>
                <ComboBox
                    filterable
                    onChange={this.onProcessSelected}
                    placeholder="Select a process..."
                    value={selectedProcessId}
                >
                    {processes.map(p => (
                        <span key={p.identifier} title={p.title} value={p.identifier}>
                            {p.title}
                        </span>
                    ))}
                </ComboBox>
                {selectedProcessId && this.state.processDescription && (
                    <div className="wps-client-abstract">
                        {this.state.processDescription.abstract}
                    </div>
                )}
            </div>
        );
    };

    renderForm = () => {
        const { processDescription, loadingDescription, formValues, validationErrors, executing, statusPercent, statusMessage } = this.state;
        const { currentTheme } = this.props;

        if (loadingDescription) {
            return <div className="wps-client-loading"><Spinner /> Loading process details...</div>;
        }

        if (!processDescription) return null;

        return (
            <div className="wps-client-section wps-client-form">
                {currentTheme && (
                    <div className="wps-client-theme-info">
                        <label className="wps-client-label">Active Theme:</label>
                        <span className="wps-client-theme-title">{currentTheme.title || currentTheme.name || currentTheme.id}</span>
                    </div>
                )}
                <label className="wps-client-label">Inputs:</label>
                {processDescription.inputs.length === 0 && (
                    <div className="wps-client-no-inputs">This process has no inputs.</div>
                )}
                {processDescription.inputs.map(input => this.renderInputField(input, formValues, validationErrors))}
                <div className="wps-client-execute">
                    {executing ? (
                        <div className="wps-client-progress">
                            <div className="wps-client-loading">
                                <Spinner /> Executing...{statusPercent !== null ? ' ' + statusPercent + '%' : ''}
                            </div>
                            {statusMessage && (
                                <div className="wps-client-status-message">{statusMessage}</div>
                            )}
                        </div>
                    ) : (
                        <button className="button" onClick={this.executeProcess}>
                            Run
                        </button>
                    )}
                </div>
            </div>
        );
    };

    renderInputField = (input, formValues, validationErrors) => {
        const value = formValues[input.identifier] || '';
        const error = validationErrors[input.identifier];
        const required = input.minOccurs > 0;

        return (
            <div className="wps-client-input-group" key={input.identifier}>
                <label className="wps-client-input-label">
                    {input.title}
                    {required && <span className="wps-client-required">*</span>}
                </label>
                {input.abstract && (
                    <div className="wps-client-input-abstract">{input.abstract}</div>
                )}
                {this.renderInputControl(input, value)}
                {error && <div className="wps-client-field-error">{error}</div>}
            </div>
        );
    };

    renderInputControl = (input, value) => {
        // If there are allowed values, render a ComboBox
        if (input.allowedValues) {
            return (
                <ComboBox
                    onChange={(val) => this.handleInputChange(input.identifier, val)}
                    placeholder="Select a value..."
                    value={value}
                >
                    {input.allowedValues.map(av => (
                        <span key={av} title={av.toString()} value={av.toString()}>
                            {av.toString()}
                        </span>
                    ))}
                </ComboBox>
            );
        }

        // Boolean type
        if (input.dataType === 'boolean') {
            return (
                <ComboBox
                    onChange={(val) => this.handleInputChange(input.identifier, val)}
                    placeholder="Select..."
                    value={value}
                >
                    <span title="true" value="true">True</span>
                    <span title="false" value="false">False</span>
                </ComboBox>
            );
        }

        // Integer or float
        if (input.dataType === 'integer' || input.dataType === 'float') {
            return (
                <NumberInput
                    decimals={input.dataType === 'float' ? 6 : 0}
                    onChange={(val) => this.handleInputChange(input.identifier, val !== null ? val.toString() : '')}
                    value={value !== '' ? parseFloat(value) : null}
                />
            );
        }

        // Default: text input
        return (
            <input
                className="wps-client-text-input"
                onChange={(ev) => this.handleInputChange(input.identifier, ev.target.value)}
                placeholder={input.title}
                type="text"
                value={value}
            />
        );
    };

    // =========================================================================
    // Jobs list tab
    // =========================================================================

    renderJobsList = () => {
        const { jobsList, loadingJobs } = this.state;

        return (
            <div className="wps-client-jobs">
                <div className="wps-client-jobs-header">
                    <label className="wps-client-label">Jobs:</label>
                    <button
                        className="button wps-client-refresh-btn"
                        disabled={loadingJobs}
                        onClick={this.fetchJobs}
                        title="Refresh jobs list"
                    >
                        {loadingJobs ? <Spinner /> : '\u21bb'}
                    </button>
                </div>
                {loadingJobs && jobsList.length === 0 && (
                    <div className="wps-client-loading"><Spinner /> Loading jobs...</div>
                )}
                {!loadingJobs && jobsList.length === 0 && (
                    <div className="wps-client-no-inputs">No jobs found.</div>
                )}
                {jobsList.map(job => this.renderJobRow(job))}
            </div>
        );
    };

    renderJobRow = (job) => {
        const isClickable = job.status === 'successful' || job.status === 'running' || job.status === 'accepted';
        const createdLabel = job.created ? new Date(job.created).toLocaleString() : null;
        const finishedLabel = job.finished ? new Date(job.finished).toLocaleString() : null;

        return (
            <div
                className={'wps-client-job-row' + (isClickable ? ' wps-client-job-row--clickable' : '')}
                key={job.jobID}
                onClick={isClickable ? () => this.handleJobRowClick(job) : undefined}
                title={isClickable ? (job.status === 'successful' ? 'Click to view results' : 'Click to resume polling') : undefined}
            >
                <div className="wps-client-job-row-top">
                    <span className="wps-client-job-process">{job.processID || job.jobID}</span>
                    <span className={'wps-client-job-status wps-client-job-status--' + job.status}>
                        {job.status}
                    </span>
                </div>
                <div className="wps-client-job-meta">
                    {createdLabel && <span>Started: {createdLabel}</span>}
                    {finishedLabel && <span>Finished: {finishedLabel}</span>}
                    {job.message && <span className="wps-client-job-message">{job.message}</span>}
                </div>
            </div>
        );
    };

    // =========================================================================
    // Results window
    // =========================================================================

    renderResultsWindow = () => {
        const { resultsWindowVisible, resultsWindowTitle, results } = this.state;

        return (
            <ResizeableWindow
                dockable="bottom"
                initialHeight={420}
                initialWidth={600}
                onClose={this.closeResultsWindow}
                title={resultsWindowTitle}
                visible={resultsWindowVisible}
            >
                <div className="wps-client-results-window" role="body">
                    {results && results.length > 0 ? (
                        results.map(output => this.renderOutputValue(output))
                    ) : (
                        <div className="wps-client-no-inputs">No results available.</div>
                    )}
                </div>
            </ResizeableWindow>
        );
    };

    renderOutputValue = (output) => {
        const { value } = output;

        // Detect line_chart visualization metadata
        if (
            value &&
            typeof value === 'object' &&
            value.visualization &&
            value.visualization.type === 'line_chart' &&
            Array.isArray(value.data)
        ) {
            const { visualization, data } = value;
            const xField = visualization.x.field;
            const yField = visualization.y.field;
            const xLabel = visualization.x.label;
            const yLabel = visualization.y.label;

            return (
                <div className="wps-client-chart-container" key={output.identifier}>
                    <div className="wps-client-chart-title">{output.title}</div>
                    <ResponsiveContainer height={300} width="100%">
                        <LineChart
                            data={data}
                            margin={{ bottom: 40, left: 10, right: 20, top: 10 }}
                        >
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis
                                angle={-45}
                                dataKey={xField}
                                label={{ offset: -10, position: 'insideBottom', value: xLabel }}
                                textAnchor="end"
                                tick={{ fontSize: 10 }}
                                tickCount={8}
                            />
                            <YAxis
                                label={{ angle: -90, offset: 10, position: 'insideLeft', value: yLabel }}
                                tick={{ fontSize: 11 }}
                            />
                            <Tooltip />
                            <Line
                                dataKey={yField}
                                dot={false}
                                stroke="#2979ff"
                                strokeWidth={2}
                                type="monotone"
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            );
        }

        // Fallback: plain key/value table row
        const displayValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
        return (
            <table className="wps-client-results-table" key={output.identifier}>
                <tbody>
                    <tr>
                        <td className="wps-client-result-label">{output.title}</td>
                        <td className="wps-client-result-value">{displayValue}</td>
                    </tr>
                </tbody>
            </table>
        );
    };
}

export default connect(
    (state) => ({
        currentTheme: state.theme.current
    }),
    {
        processFinished: processFinished,
        processStarted: processStarted
    }
)(OGCProcessClient);
