import { defineInterface } from '@directus/extensions-sdk';
import InterfaceO2M from './interface.vue';

export default defineInterface({
  id: 'o2m-map',
  name: 'One-to-Many Map',
  icon: 'map',
  description: 'Edit a one-to-many relation using a map of related items on a map.',
  // For O2M interfaces you must declare alias + localTypes + relational
  types: ['alias'],
  localTypes: ['o2m'],
  group: 'relational',
  relational: true,
  component: InterfaceO2M,
  recommendedDisplays: ['related-values'],
  // Options are dynamic so we can prefill collection context just like core list-o2m
  options: ({ relations, field: { meta } }) => {
    const collection = relations.o2m?.collection;
    const opts = meta?.options ?? {};

    return [
      {
        field: 'geometry_field',
        name: 'Geometry Field (GeoJSON)',
        type: 'string',
        meta: { width: 'half', interface: 'system-field', options: { collectionName: collection } }
      },
      // {
      //   field: 'label_template',
      //   name: 'Label Template (for popup)',
      //   type: 'string',
      //   schema: { default_value: '{{ $display }}' },
      //   meta: { width: 'full', interface: 'system-display-template', options: { collectionName: collection } }
      // },
      {
        field: 'map_style',
        name: 'MapLibre Style URL',
        type: 'string',
        schema: { default_value: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' },
        meta: { width: 'half', interface: 'input' }
      },
      {
        field: 'cluster',
        name: 'Cluster Point Features',
        type: 'boolean',
        schema: { default_value: true },
        meta: { width: 'half', interface: 'boolean' }
      },
      {
        field: 'allow_create',
        name: 'Allow Creating New Related Items by Clicking Map',
        type: 'boolean',
        schema: { default_value: false },
        meta: { width: 'half', interface: 'boolean' }
      },
      {
        field: 'fit_on_load',
        name: 'Fit to Data on Load',
        type: 'boolean',
        schema: { default_value: true },
        meta: { width: 'half', interface: 'boolean' }
      },
      {
        field: 'limit',
        name: '$t:per_page',
        type: 'integer',
        schema: { default_value: 1000 },
        meta: { width: 'half', interface: 'input' }
      }
    ];
  },
});