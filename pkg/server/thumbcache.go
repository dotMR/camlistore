/*
Copyright 2011 Google Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package server

import (
	"errors"
	"fmt"

	"camlistore.org/pkg/blob"
	"camlistore.org/pkg/lru"
	"camlistore.org/pkg/sorted"
)

const memLRUSize = 1024 // arbitrary

// thumbMeta is a mapping from an image's scaling parameters (encoding
// as an opaque "key" string) and the blobref of the thumbnail
// (currently it's file schema blob)
//
// The key will be some string containing the original full-sized image's
// blobref, its target dimensions, and any possible transformations on
// it (e.g. cropping it to square).

var errCacheMiss = errors.New("not in cache")

type thumbMeta struct {
	mem *lru.Cache      // string (see key format) -> blob.Ref
	kv  sorted.KeyValue // optional
}

// kv is optional
func newThumbMeta(kv sorted.KeyValue) *thumbMeta {
	return &thumbMeta{
		mem: lru.New(memLRUSize),
		kv:  kv,
	}
}

func (m *thumbMeta) Get(key string) (br blob.Ref, err error) {
	if v, ok := m.mem.Get(key); ok {
		return v.(blob.Ref), nil
	}
	if m.kv != nil {
		v, err := m.kv.Get(key)
		if err == sorted.ErrNotFound {
			return br, errCacheMiss
		}
		if err != nil {
			return br, err
		}
		br, ok := blob.Parse(v)
		if !ok {
			return br, fmt.Errorf("Invalid blobref %q found for key %q in thumbnail mea", v, key)
		}
		m.mem.Add(key, br)
		return br, nil
	}
	return br, errCacheMiss
}

func (m *thumbMeta) Put(key string, br blob.Ref) error {
	m.mem.Add(key, br)
	if m.kv != nil {
		return m.kv.Set(key, br.String())
	}
	return nil
}
