import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../../api';
import type { LeadFilter, LeadSortField } from '../../api/Api';
import {
  Badge,
  Button,
  ConfirmDialog,
  IconDownload,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUpload,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  useToast,
  type SortState,
  type TableColumn,
} from '../../components/ui';
import { useNavigation } from '../../layout/navigation';
import { formatDate, formatDateTime, formatPhone, formatRelative, toDateKey } from '../../lib/format';
import { LEAD_STATUSES, leadStatusLabel, type Lead, type LeadList, type LeadStatus, type Profile } from '../../types';
import { ImportWizard } from './leads/ImportWizard';
import { LeadDetailModal } from './leads/LeadDetailModal';
import { STATUS_TONE, downloadCsv, plural, safeFileName, useDebounced } from './leads/leadUi';
import './leads/leads.css';

const PAGE_SIZE = 50;
const SORTABLE: Record<string, LeadSortField> = {
  business: 'businessName',
  contact: 'contactName',
  status: 'status',
  attempts: 'attemptDays',
  lastCalled: 'lastCalledAt',
  nextCall: 'nextCallAt',
};

type Confirm = null | { kind: 'deleteList'; list: LeadList } | { kind: 'deleteLeads'; count: number };

/** Admin: lead lists, the lead table, bulk actions, detail editing, import and export. */
export default function Leads() {
  const toast = useToast();
  const [lists, setLists] = useState<LeadList[]>([]);
  const [users, setUsers] = useState<Profile[]>([]);
  const [listId, setListId] = useState<string>('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search.trim(), 300);
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [assigned, setAssigned] = useState<string>('');
  const [sort, setSort] = useState<SortState>(null);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [bulkCaller, setBulkCaller] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [detail, setDetail] = useState<Lead | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [newListOpen, setNewListOpen] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [exporting, setExporting] = useState(false);

  const filter: LeadFilter = useMemo(
    () => ({
      listId: listId || undefined,
      status: status || undefined,
      assignedTo: assigned || undefined,
      search: debouncedSearch || undefined,
    }),
    [listId, status, assigned, debouncedSearch],
  );

  const loadLists = useCallback(async () => {
    try {
      const ls = await api.listLeadLists();
      setLists(ls);
      setListId((cur) => (cur && !ls.some((l) => l.id === cur) ? '' : cur));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [toast]);

  useEffect(() => {
    void loadLists();
    api.listUsers().then(setUsers, (e) => toast.error(errorMessage(e)));
  }, [loadLists, toast]);

  // Other screens may open a lead directly: navigate('leads', { leadId }).
  const { params } = useNavigation();
  useEffect(() => {
    if (!params.leadId) return;
    let alive = true;
    api.getLead(params.leadId).then(
      (l) => alive && setDetail(l),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [params.leadId]);

  // New filter -> first page, clear selection.
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
    setAllMatching(false);
  }, [filter, sort]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const field = sort ? SORTABLE[sort.key] : undefined;
    api
      .queryLeads({ ...filter, page, pageSize: PAGE_SIZE, sort: field && sort ? { field, dir: sort.dir } : undefined })
      .then((res) => {
        if (!alive) return;
        setRows(res.rows);
        setTotal(res.total);
        setLoadError('');
        // A page past the end (after deletes): step back.
        if (res.rows.length === 0 && res.total > 0 && page > 1) setPage(Math.max(1, Math.ceil(res.total / PAGE_SIZE)));
      })
      .catch((e) => alive && setLoadError(errorMessage(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [filter, sort, page, reloadKey]);

  const refresh = () => {
    setReloadKey((k) => k + 1);
    void loadLists();
  };

  const userName = useMemo(() => new Map(users.map((u) => [u.id, u.fullName])), [users]);
  const callers = useMemo(() => users.filter((u) => u.role === 'caller'), [users]);
  const activeCallers = useMemo(() => callers.filter((u) => u.active), [callers]);
  const listName = useMemo(() => new Map(lists.map((l) => [l.id, l.name])), [lists]);
  const currentList = lists.find((l) => l.id === listId) ?? null;
  const allTotals = useMemo(() => lists.reduce((acc, l) => ({ total: acc.total + l.leadCount, remaining: acc.remaining + l.remainingCount }), { total: 0, remaining: 0 }), [lists]);

  const selectedCount = allMatching ? total : selected.size;
  const pageIds = rows.map((r) => r.id);
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const toggleRow = (id: string, on: boolean) => {
    setAllMatching(false);
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  };
  const togglePage = (on: boolean) => {
    setAllMatching(false);
    setSelected((s) => {
      const n = new Set(s);
      for (const id of pageIds) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });
  };
  const clearSelection = () => {
    setSelected(new Set());
    setAllMatching(false);
  };

  const selectedIds = async (): Promise<string[]> => (allMatching ? (await api.exportLeads(filter)).map((l) => l.id) : [...selected]);

  const bulkAssign = async (to: string | null) => {
    setBusy(true);
    try {
      const ids = await selectedIds();
      const n = await api.assignLeads({ leadIds: ids, assignTo: to });
      toast.success(to ? `${plural(n, 'lead')} assigned to ${userName.get(to) ?? 'caller'}.` : `${plural(n, 'lead')} moved to the shared pool.`);
      clearSelection();
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const bulkDelete = async () => {
    setBusy(true);
    try {
      const ids = await selectedIds();
      const n = await api.deleteLeads(ids);
      toast.success(`${plural(n, 'lead')} deleted.`);
      clearSelection();
      setConfirm(null);
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteList = async (list: LeadList) => {
    setBusy(true);
    try {
      await api.deleteLeadList(list.id);
      toast.success(`Deleted “${list.name}”.`);
      setConfirm(null);
      setListId('');
      refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const createList = async () => {
    const name = newListName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const l = await api.createLeadList(name);
      toast.success(`Created “${l.name}”.`);
      setNewListOpen(false);
      setNewListName('');
      await loadLists();
      setListId(l.id);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const leads = await api.exportLeads(filter);
      if (leads.length === 0) {
        toast.info('Nothing to export with these filters.');
        return;
      }
      const fields = ['Business', 'Contact', 'Phone 1', 'Phone 2', 'Phone 3', 'Email', 'City', 'State', 'Status', 'Assigned to', 'Days tried', 'Last called', 'Next call', 'Notes', 'List', 'Added'];
      const data = leads.map((l) => [
        l.businessName,
        l.contactName,
        formatPhone(l.phones[0] ?? ''),
        formatPhone(l.phones[1] ?? ''),
        formatPhone(l.phones[2] ?? ''),
        l.email,
        l.city,
        l.state,
        leadStatusLabel(l.status),
        l.assignedTo ? userName.get(l.assignedTo) ?? '' : 'Shared pool',
        l.attemptDays,
        formatDateTime(l.lastCalledAt),
        formatDateTime(l.nextCallAt),
        l.notes,
        listName.get(l.listId) ?? '',
        formatDate(l.createdAt),
      ]);
      downloadCsv(`${safeFileName(currentList?.name ?? 'All leads')} ${toDateKey(new Date())}.csv`, fields, data);
      toast.success(`Exported ${plural(leads.length, 'lead')}.`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const columns: TableColumn<Lead>[] = [
    {
      key: 'select',
      width: 36,
      header: (
        <input
          type="checkbox"
          className="adm-check"
          aria-label="Select all on this page"
          checked={pageAllSelected || allMatching}
          onChange={(e) => togglePage(e.target.checked)}
        />
      ),
      render: (l) => (
        <input
          type="checkbox"
          className="adm-check"
          aria-label={`Select ${l.businessName}`}
          checked={allMatching || selected.has(l.id)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => toggleRow(l.id, e.target.checked)}
        />
      ),
    },
    {
      key: 'business',
      header: 'Business',
      sortValue: (l) => l.businessName,
      render: (l) => (
        <span className="adm-clip cell-link" title={l.businessName}>
          {l.businessName}
        </span>
      ),
    },
    { key: 'contact', header: 'Contact', sortValue: (l) => l.contactName, render: (l) => <span className="adm-clip">{l.contactName || <span className="muted">-</span>}</span> },
    {
      key: 'phone',
      header: 'Phone',
      render: (l) => (
        <span className="num">
          {formatPhone(l.phones[0] ?? '')}
          {l.phones.length > 1 && <span className="cell-sub"> +{l.phones.length - 1}</span>}
        </span>
      ),
    },
    { key: 'place', header: 'City, state', render: (l) => [l.city, l.state].filter(Boolean).join(', ') || <span className="muted">-</span> },
    {
      key: 'status',
      header: 'Status',
      sortValue: (l) => l.status,
      render: (l) => (
        <Badge tone={STATUS_TONE[l.status]} dot>
          {leadStatusLabel(l.status)}
        </Badge>
      ),
    },
    { key: 'assigned', header: 'Owner', render: (l) => (l.assignedTo ? userName.get(l.assignedTo) ?? 'Unknown' : <span className="muted">Shared pool</span>) },
    { key: 'attempts', header: 'Tries', align: 'right', sortValue: (l) => l.attemptDays, render: (l) => <span className="num">{l.attemptDays}</span> },
    {
      key: 'lastCalled',
      header: 'Last called',
      sortValue: (l) => l.lastCalledAt,
      render: (l) => (l.lastCalledAt ? <span title={formatDateTime(l.lastCalledAt)}>{formatRelative(l.lastCalledAt)}</span> : <span className="muted">Never</span>),
    },
    {
      key: 'nextCall',
      header: 'Next call',
      sortValue: (l) => l.nextCallAt,
      render: (l) => {
        const dialable = LEAD_STATUSES.find((s) => s.value === l.status)?.dialable;
        if (!dialable) return <span className="muted">-</span>;
        if (!l.nextCallAt || new Date(l.nextCallAt).getTime() <= Date.now()) return 'Now';
        return <span title={formatDateTime(l.nextCallAt)}>{formatRelative(l.nextCallAt)}</span>;
      },
    },
  ];

  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const filtered = Boolean(status || assigned || debouncedSearch);
  const remaining = currentList ? currentList.remainingCount : allTotals.remaining;

  return (
    <div className="screen screen-fill leads-screen">
      <PageHeader
        title="Leads"
        subtitle={`${currentList ? currentList.name : 'All lists'} · ${(currentList ? currentList.leadCount : allTotals.total).toLocaleString('en-US')} leads · ${remaining.toLocaleString('en-US')} left to call`}
        actions={
          <>
            <Button icon={<IconDownload />} onClick={() => void exportCsv()} loading={exporting}>
              Export CSV
            </Button>
            <Button variant="primary" icon={<IconUpload />} onClick={() => setImportOpen(true)}>
              Import leads
            </Button>
          </>
        }
      />

      <div className="data-panel leads-panel">
      <section className="lists-bar" aria-label="Lead lists">
        <div className="list-chips" role="radiogroup" aria-label="Choose a list">
          <button
            type="button"
            role="radio"
            aria-checked={listId === ''}
            className={`list-chip ${listId === '' ? 'active' : ''}`}
            onClick={() => setListId('')}
            title={`${allTotals.total.toLocaleString('en-US')} leads · ${allTotals.remaining.toLocaleString('en-US')} left to call`}
          >
            <span className="list-chip-name">All lists</span>
            <span className="list-chip-counts">{allTotals.total.toLocaleString('en-US')}</span>
          </button>
          {lists.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={listId === l.id}
              className={`list-chip ${listId === l.id ? 'active' : ''}`}
              onClick={() => setListId(l.id)}
              title={`${l.name}: ${l.leadCount.toLocaleString('en-US')} leads, ${l.remainingCount.toLocaleString('en-US')} left to call, added ${formatDate(l.createdAt)}`}
            >
              <span className="list-chip-name">{l.name}</span>
              <span className="list-chip-counts">{l.leadCount.toLocaleString('en-US')}</span>
            </button>
          ))}
        </div>
        <div className="lists-actions">
          {currentList && (
            <Button size="sm" variant="ghost" icon={<IconTrash size={13} />} onClick={() => setConfirm({ kind: 'deleteList', list: currentList })}>
              Delete this list
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<IconPlus size={13} />} onClick={() => setNewListOpen(true)}>
            New list
          </Button>
        </div>
      </section>

      <div className="toolbar leads-filters">
        <div className="adm-search">
          <IconSearch className="search-icon" size={14} />
          <Input aria-label="Search leads" placeholder="Search business, contact, email, city or phone" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value as LeadStatus | '')}
          options={[{ value: '', label: 'Any status' }, ...LEAD_STATUSES.map((s) => ({ value: s.value, label: s.label }))]}
          fieldClassName="filter-select"
        />
        <Select
          aria-label="Assigned to"
          value={assigned}
          onChange={(e) => setAssigned(e.target.value)}
          options={[{ value: '', label: 'Assigned to anyone' }, { value: 'pool', label: 'Shared pool only' }, ...callers.map((u) => ({ value: u.id, label: u.active ? u.fullName : `${u.fullName} (inactive)` }))]}
          fieldClassName="filter-select"
        />
        {filtered && (
          <span className="tb-count">
            <strong>{total.toLocaleString('en-US')}</strong> {total === 1 ? 'match' : 'matches'}
          </span>
        )}
        <div className="tb-right adm-pager">
          {loading && <Spinner size={14} />}
          <span className="tb-count" title={`Page ${page} of ${pages}`}>
            {total === 0 ? 'No leads' : `${from.toLocaleString('en-US')}-${to.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`}
          </span>
          <div className="btn-group">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      </div>

      {selectedCount > 0 && (
        <div className="toolbar toolbar-selected bulk-bar" role="region" aria-label="Selected leads">
          <strong>{plural(selectedCount, 'lead')} selected</strong>
          {!allMatching && pageAllSelected && total > rows.length && (
            <button type="button" className="adm-link" onClick={() => setAllMatching(true)}>
              Select all {total.toLocaleString('en-US')} matching
            </button>
          )}
          <button type="button" className="adm-link" onClick={clearSelection}>
            Clear
          </button>
          <span className="spacer" />
          <div className="bulk-actions">
            <Select
              aria-label="Assign to caller"
              value={bulkCaller}
              onChange={(e) => setBulkCaller(e.target.value)}
              placeholder="Choose a caller"
              options={activeCallers.map((u) => ({ value: u.id, label: u.fullName }))}
              fieldClassName="bulk-select"
            />
            <Button size="sm" variant="primary" disabled={!bulkCaller || busy} onClick={() => void bulkAssign(bulkCaller)}>
              Assign
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void bulkAssign(null)}>
              Move to shared pool
            </Button>
            <Button size="sm" variant="danger" icon={<IconTrash />} disabled={busy} onClick={() => setConfirm({ kind: 'deleteLeads', count: selectedCount })}>
              Delete
            </Button>
          </div>
        </div>
      )}

      {loadError ? (
        <div className="form-error leads-error">{loadError}</div>
      ) : (
        <div className={`leads-table ${loading ? 'is-loading' : ''}`}>
          <Table
            columns={columns}
            rows={rows}
            rowKey={(l) => l.id}
            onRowClick={(l) => setDetail(l)}
            selectedKey={detail?.id ?? null}
            sort={sort}
            onSortChange={setSort}
            dense
            caption="Leads"
            empty={
              loading ? (
                <span className="row">
                  <Spinner size={14} /> Loading
                </span>
              ) : lists.length === 0 ? (
                'No leads yet. Use “Import leads” to upload your first spreadsheet.'
              ) : (
                'No leads match these filters.'
              )
            }
          />
        </div>
      )}
      </div>

      <LeadDetailModal
        lead={detail}
        users={users}
        lists={lists}
        onClose={() => setDetail(null)}
        onSaved={() => {
          setDetail(null);
          refresh();
        }}
      />

      <ImportWizard
        open={importOpen}
        lists={lists}
        users={users}
        onClose={(importedListId) => {
          setImportOpen(false);
          if (importedListId) {
            setListId(importedListId);
            refresh();
          }
        }}
      />

      <Modal
        open={newListOpen}
        onClose={() => setNewListOpen(false)}
        title="New list"
        size="sm"
        footer={
          <>
            <Button onClick={() => setNewListOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!newListName.trim()} loading={busy} onClick={() => void createList()}>
              Create list
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createList();
          }}
        >
          <Input label="List name" value={newListName} onChange={(e) => setNewListName(e.target.value)} placeholder="e.g. Plano HVAC November" />
        </form>
      </Modal>

      <ConfirmDialog
        open={confirm?.kind === 'deleteList'}
        title="Delete this list?"
        danger
        busy={busy}
        confirmLabel="Delete list and leads"
        message={
          confirm?.kind === 'deleteList'
            ? `“${confirm.list.name}” and all ${plural(confirm.list.leadCount, 'lead')} in it will be deleted. Call history is kept. This can't be undone.`
            : ''
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm?.kind === 'deleteList' && void deleteList(confirm.list)}
      />
      <ConfirmDialog
        open={confirm?.kind === 'deleteLeads'}
        title="Delete leads?"
        danger
        busy={busy}
        confirmLabel={confirm?.kind === 'deleteLeads' ? `Delete ${plural(confirm.count, 'lead')}` : 'Delete'}
        message={confirm?.kind === 'deleteLeads' ? `${plural(confirm.count, 'lead')} will be permanently deleted. Call history is kept. This can't be undone.` : ''}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void bulkDelete()}
      />
    </div>
  );
}
