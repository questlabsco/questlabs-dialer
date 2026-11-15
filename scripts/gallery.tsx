// Dev-only gallery of every shared UI component and variant (see gallery.html).
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/theme.css';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Drawer,
  EmptyState,
  IconButton,
  IconDownload,
  IconEdit,
  IconLeads,
  IconPhone,
  IconPlus,
  IconSearch,
  IconStats,
  IconTrash,
  IconUpload,
  Input,
  Logo,
  Modal,
  PageHeader,
  Select,
  Spinner,
  StatTile,
  Table,
  Tabs,
  Textarea,
  ToastProvider,
  useToast,
  type TableColumn,
} from '../src/components/ui';

interface Row {
  id: string;
  name: string;
  company: string;
  phone: string;
  status: 'new' | 'booked' | 'callback' | 'no_answer' | 'dnc';
  calls: number;
  pickup: number;
}

const ROWS: Row[] = [
  { id: '1', name: 'Marisol Gutierrez', company: 'Gutierrez Family Dental of North Richland Hills', phone: '(817) 555-0142', status: 'booked', calls: 3, pickup: 0.67 },
  { id: '2', name: 'Darnell Brooks', company: 'Brooks HVAC', phone: '(214) 555-0187', status: 'callback', calls: 2, pickup: 0.5 },
  { id: '3', name: 'Priya Raman', company: 'Raman Accounting', phone: '(469) 555-0110', status: 'new', calls: 0, pickup: 0 },
  { id: '4', name: 'Tom Whitfield', company: 'Whitfield Roofing & Exteriors', phone: '(972) 555-0199', status: 'no_answer', calls: 6, pickup: 0 },
  { id: '5', name: 'Alana Cho', company: 'Cho Pilates Studio', phone: '(682) 555-0123', status: 'dnc', calls: 1, pickup: 1 },
];

const STATUS: Record<Row['status'], { label: string; tone: 'neutral' | 'accent' | 'good' | 'warning' | 'critical' }> = {
  new: { label: 'New', tone: 'neutral' },
  booked: { label: 'Booked', tone: 'good' },
  callback: { label: 'Callback', tone: 'accent' },
  no_answer: { label: 'No answer', tone: 'warning' },
  dnc: { label: 'Do not call', tone: 'critical' },
};

const columns: TableColumn<Row>[] = [
  {
    key: 'name',
    header: 'Lead',
    sortValue: (r) => r.name,
    render: (r) => (
      <span className="row">
        <Avatar name={r.name} size={24} />
        <span style={{ fontWeight: 550 }}>{r.name}</span>
      </span>
    ),
  },
  { key: 'company', header: 'Company', truncate: true, maxWidth: 220, sortValue: (r) => r.company },
  { key: 'phone', header: 'Phone', render: (r) => <span className="num">{r.phone}</span> },
  { key: 'status', header: 'Status', render: (r) => <Badge tone={STATUS[r.status].tone} dot>{STATUS[r.status].label}</Badge> },
  { key: 'calls', header: 'Calls', align: 'right', sortValue: (r) => r.calls },
  { key: 'pickup', header: 'Pickup rate', align: 'right', sortValue: (r) => r.pickup, render: (r) => `${Math.round(r.pickup * 100)}%` },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card title={title}>
      <div className="stack">{children}</div>
    </Card>
  );
}

function Gallery() {
  const show = new URLSearchParams(location.search).get('show');
  const toast = useToast();
  const [tab, setTab] = useState('all');
  const [pill, setPill] = useState('today');
  const [checked, setChecked] = useState(true);
  const [modal, setModal] = useState(show === 'modal');
  const [drawer, setDrawer] = useState(show === 'drawer');
  const [confirm, setConfirm] = useState(show === 'confirm');

  useEffect(() => {
    if (show === 'toasts') {
      toast.success('Lead saved');
      toast.info('Two leads assigned to Darnell');
      toast.show({ message: 'Number (214) 555-0100 is near its daily cap', tone: 'warning' });
      toast.error('Could not reach the server. Retrying...');
    }
  }, [show, toast]);

  return (
    <div className="screen" style={{ maxWidth: 1200 }}>
      <PageHeader
        title="Component gallery"
        subtitle="Every shared component and variant, light and dark"
        actions={
          <>
            <Button icon={<IconDownload size={15} />}>Export</Button>
            <Button variant="primary" icon={<IconPlus size={15} />}>
              Add lead
            </Button>
          </>
        }
      />

      <div className="stat-grid">
        <StatTile label="Dials today" value="1,284" delta={0.12} icon={<IconPhone size={14} />} />
        <StatTile label="Connects" value="212" delta={-0.08} sub="16.5% connect rate" />
        <StatTile label="Booked" value="9" delta={0} />
        <StatTile label="Dropped pickups" value="3" delta={-0.4} invertDelta />
        <StatTile label="Talk time" value="4h 12m" icon={<IconStats size={14} />} />
      </div>

      <Section title="Buttons">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon={<IconTrash size={15} />}>
            Danger
          </Button>
          <Button variant="good" icon={<IconPhone size={15} />}>
            Good
          </Button>
          <Button variant="primary" loading>
            Saving
          </Button>
          <Button disabled>Disabled</Button>
          <IconButton label="Edit" icon={<IconEdit size={16} />} />
          <IconButton label="Upload" icon={<IconUpload size={16} />} variant="secondary" />
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Button variant="primary" size="sm">
            Small
          </Button>
          <Button size="sm">Small</Button>
          <Button variant="primary" size="lg">
            Large primary
          </Button>
          <Button size="lg">Large</Button>
        </div>
      </Section>

      <Section title="Status pills">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Badge>Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <Badge tone="good">Good</Badge>
          <Badge tone="warning">Warning</Badge>
          <Badge tone="critical">Critical</Badge>
          <Badge dot>New</Badge>
          <Badge tone="accent" dot>
            Callback
          </Badge>
          <Badge tone="good" dot>
            Booked
          </Badge>
          <Badge tone="warning" dot>
            No answer
          </Badge>
          <Badge tone="critical" dot>
            Do not call
          </Badge>
          <Badge tone="accent" size="sm">
            12
          </Badge>
          <Badge tone="good" size="lg" dot>
            Live
          </Badge>
          <Badge tone="accent" outline>
            Outline
          </Badge>
        </div>
      </Section>

      <Card title="Leads" subtitle="Table: sticky header, sorting, truncation, hover and selected" actions={<Input aria-label="Search" placeholder="Search leads" leadingIcon={<IconSearch size={14} />} />} padded={false}>
        <Table columns={columns} rows={ROWS} rowKey={(r) => r.id} selectedKey="2" onRowClick={() => setDrawer(true)} />
      </Card>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Table columns={columns.slice(0, 4)} rows={ROWS} rowKey={(r) => r.id} dense maxHeight={150} caption="Dense" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Table columns={columns.slice(0, 3)} rows={[]} rowKey={(r) => r.id} empty="No leads match these filters." />
        </div>
      </div>

      <Section title="Tabs">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'all', label: 'All leads', badge: <Badge size="sm">1,204</Badge> },
            { id: 'pool', label: 'Shared pool', badge: <Badge size="sm">880</Badge> },
            { id: 'assigned', label: 'Assigned' },
            { id: 'off', label: 'Disabled', disabled: true },
          ]}
        />
        <Tabs
          variant="pills"
          value={pill}
          onChange={setPill}
          tabs={[
            { id: 'today', label: 'Today' },
            { id: '7d', label: '7 days' },
            { id: '30d', label: '30 days' },
          ]}
        />
      </Section>

      <Section title="Forms">
        <div className="form-grid">
          <Input label="Full name" placeholder="Jane Doe" />
          <Input label="Phone" hint="US numbers only" defaultValue="(214) 555-0187" />
          <Input label="Email" error="Enter a valid email address" defaultValue="jane@" />
          <Input label="Disabled" disabled defaultValue="Read only" />
          <Select label="Assign to" placeholder="Shared pool" options={[{ value: 'd', label: 'Darnell Brooks' }, { value: 'p', label: 'Priya Raman' }]} />
          <Select label="Outcome" error="Pick an outcome" placeholder="Choose..." options={[{ value: 'b', label: 'Booked' }]} />
        </div>
        <Textarea label="Note" hint="Visible to admins and the caller" placeholder="What happened on the call?" />
        <Checkbox label="Retry no-answers tomorrow" hint="Up to 3 days" checked={checked} onChange={setChecked} />
      </Section>

      <div className="row" style={{ alignItems: 'stretch', gap: 16 }}>
        <Card style={{ flex: 1 }}>
          <EmptyState icon={<IconLeads size={24} />} title="No leads yet" message="Upload a spreadsheet to start calling. Any column layout works." action={<Button variant="primary" icon={<IconUpload size={15} />}>Upload leads</Button>} />
        </Card>
        <Card title="Misc" style={{ flex: 1 }}>
          <div className="stack">
            <div className="row">
              <Spinner /> <Spinner size={28} label="Loading" />
              <Avatar name="Marisol Gutierrez" />
              <Avatar name="Darnell Brooks" size={36} />
              <Avatar name="Priya" size={22} />
            </div>
            <div className="row">
              <Logo size={32} />
              <span style={{ background: 'var(--sidebar-bg)', padding: 8, borderRadius: 8, display: 'inline-flex' }}>
                <Logo size={32} variant="reversed" />
              </span>
            </div>
            <div className="row">
              <Button onClick={() => setModal(true)}>Open modal</Button>
              <Button onClick={() => setDrawer(true)}>Open drawer</Button>
              <Button onClick={() => setConfirm(true)}>Confirm</Button>
              <Button onClick={() => toast.success('Saved')}>Toast</Button>
            </div>
            <span className="muted">
              Press <span className="kbd">Space</span> to dial next
            </span>
          </div>
        </Card>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Add a caller"
        footer={
          <>
            <Button onClick={() => setModal(false)}>Cancel</Button>
            <Button variant="primary">Send invite</Button>
          </>
        }
      >
        <div className="form-stack">
          <Input label="Full name" placeholder="Jane Doe" />
          <Input label="Email" hint="They get a link to set a password" placeholder="jane@questlabs.co" />
          <Select label="Role" options={[{ value: 'caller', label: 'Caller' }, { value: 'admin', label: 'Admin' }]} />
        </div>
      </Modal>

      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        title="Darnell Brooks"
        subtitle="Brooks HVAC - (214) 555-0187"
        headerActions={<Badge tone="accent" dot>Callback</Badge>}
        footer={
          <>
            <Button onClick={() => setDrawer(false)}>Close</Button>
            <Button variant="primary" icon={<IconEdit size={15} />}>
              Edit lead
            </Button>
          </>
        }
      >
        <div className="stack" style={{ gap: 20 }}>
          <dl className="kv">
            <dt>Owner</dt>
            <dd>Priya Raman</dd>
            <dt>Phones</dt>
            <dd className="num">(214) 555-0187, (469) 555-0110</dd>
            <dt>City</dt>
            <dd>Plano, TX</dd>
            <dt>Last call</dt>
            <dd>Today 10:42 AM - callback requested</dd>
          </dl>
          <div className="stat-grid">
            <StatTile label="Calls" value="2" />
            <StatTile label="Talk time" value="3m 10s" />
          </div>
          <Textarea label="Note" defaultValue="Wants a call after 3pm, owner is on site in the morning." />
        </div>
      </Drawer>

      <ConfirmDialog open={confirm} title="Delete 12 leads?" message="They will be removed from every caller's queue. This cannot be undone." confirmLabel="Delete" danger onCancel={() => setConfirm(false)} onConfirm={() => setConfirm(false)} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <div className="main" style={{ height: '100%' }}>
        <Gallery />
      </div>
    </ToastProvider>
  </StrictMode>,
);
