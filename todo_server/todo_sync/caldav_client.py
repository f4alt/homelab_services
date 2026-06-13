from __future__ import annotations

import re
from xml.sax.saxutils import escape
from urllib.parse import urljoin

import requests
import urllib3

from .models import Task
from .vtodo import task_from_ical, task_to_ical

try:
    from urllib3.exceptions import InsecureRequestWarning
except ImportError:  # pragma: no cover
    InsecureRequestWarning = None


def safe_collection_slug(prefix, slug):
    raw = f"{prefix}{slug}"
    raw = re.sub(r"[^A-Za-z0-9_-]+", "-", raw).strip("-").lower()
    return raw or "todos"


class CalDavStore:
    def __init__(self, base_url, username, password, collection_prefix="", verify_ssl=True, timeout=20):
        self.base_url = base_url if base_url.endswith("/") else f"{base_url}/"
        self.username = username
        self.password = password
        self.collection_prefix = collection_prefix
        self.verify_ssl = verify_ssl
        self.timeout = timeout
        self.session = requests.Session()
        self.session.auth = (username, password)
        self.session.verify = verify_ssl
        if not verify_ssl and InsecureRequestWarning is not None:
            urllib3.disable_warnings(category=InsecureRequestWarning)

    def _collection_url(self, collection):
        slug = safe_collection_slug(self.collection_prefix, collection)
        return urljoin(self.base_url, f"{self.username}/{slug}/")

    def _task_url(self, task):
        return urljoin(self._collection_url(task.collection or task.source_file), f"{task.uid}.ics")

    def ensure_collection(self, collection, display_name=None):
        url = self._collection_url(collection)
        response = self.session.request(
            "MKCALENDAR",
            url,
            data=self._mkcalendar_body(display_name or collection),
            timeout=self.timeout,
        )
        if response.status_code in {201, 204, 405, 409}:
            return url
        response.raise_for_status()
        return url

    @staticmethod
    def _mkcalendar_body(display_name):
        display_name = escape(display_name)
        return f"""<?xml version="1.0" encoding="utf-8" ?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set>
    <D:prop>
      <D:displayname>{display_name}</D:displayname>
      <C:supported-calendar-component-set>
        <C:comp name="VTODO"/>
      </C:supported-calendar-component-set>
    </D:prop>
  </D:set>
</C:mkcalendar>"""

    def get_tasks(self, collections):
        tasks = []
        for source_file, collection in collections.items():
            self.ensure_collection(collection, source_file)
            tasks.extend(self._get_collection_tasks(source_file, collection))
        return tasks

    def _get_collection_tasks(self, source_file, collection):
        url = self._collection_url(collection)
        body = """<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VTODO"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>"""
        response = self.session.request("REPORT", url, data=body, headers={"Depth": "1"}, timeout=self.timeout)
        if response.status_code == 404:
            return []
        response.raise_for_status()
        return self._parse_multistatus(response.text, source_file, collection)

    def _parse_multistatus(self, xml_text, source_file, collection):
        import xml.etree.ElementTree as ET

        namespaces = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:caldav"}
        root = ET.fromstring(xml_text)
        tasks = []
        for response in root.findall("d:response", namespaces):
            href = response.findtext("d:href", default="", namespaces=namespaces)
            etag = response.findtext(".//d:getetag", default="", namespaces=namespaces)
            data = response.findtext(".//c:calendar-data", default="", namespaces=namespaces)
            if not data:
                continue
            task = task_from_ical(
                data,
                source_file=source_file,
                collection=collection,
                meta={"etag": etag.strip('"'), "href": href},
            )
            if task is not None:
                tasks.append(task)
        return tasks

    def put_task(self, task, etag=None):
        self.ensure_collection(task.collection or task.source_file, task.source_file)
        headers = {"Content-Type": "text/calendar; charset=utf-8"}
        if etag:
            headers["If-Match"] = f'"{etag}"'
        response = self.session.put(self._task_url(task), data=task_to_ical(task), headers=headers, timeout=self.timeout)
        if response.status_code == 412:
            return False
        response.raise_for_status()
        task.meta["etag"] = response.headers.get("ETag", "").strip('"')
        return True

    def delete_task(self, task, etag=None):
        headers = {}
        if etag:
            headers["If-Match"] = f'"{etag}"'
        response = self.session.delete(self._task_url(task), headers=headers, timeout=self.timeout)
        if response.status_code in {404, 412}:
            return response.status_code != 412
        response.raise_for_status()
        return True
